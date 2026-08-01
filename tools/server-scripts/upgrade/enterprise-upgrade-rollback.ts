import fs from "node:fs/promises";
import path from "node:path";

const IMAGE_PATTERN: any =
  /^(?=.{1,512}$)[a-z0-9]+(?:[._-][a-z0-9]+)*(?::[0-9]+)?(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)+@sha256:[a-f0-9]{64}$/u;
const JOURNAL_SCHEMA: any = "v0.0.1:enterprise-upgrade:rollback-journal-1";

function upgradeError(code?: any, message?: any, cause: any = null) : any {
  return Object.assign(new Error(message, cause ? { cause } : undefined), { code });
}

function imageReference(value?: any, code?: any) : any {
  const selected: any = String(value || "").trim();
  if (!IMAGE_PATTERN.test(selected)) throw upgradeError(code, code);
  return selected;
}

function requirePort(owner?: any, method?: any) : any {
  if (typeof owner?.[method] !== "function") {
    throw upgradeError("enterprise_upgrade_port_missing", `Missing upgrade port: ${method}`);
  }
}

export function createFileUpgradeJournal({ journalFile = "" }: Record<string, any> = {}) : any {
  const selected: any = path.resolve(String(journalFile || ""));
  if (!journalFile || !path.isAbsolute(journalFile)) {
    throw upgradeError("enterprise_upgrade_journal_path_invalid", "Upgrade journal path must be absolute.");
  }
  return Object.freeze({
    async write(record?: any) : Promise<any> {
      await fs.mkdir(path.dirname(selected), { recursive: true, mode: 0o700 });
      const temporary: any = `${selected}.${process.pid}.pending`;
      let handle: any = null;
      try {
        handle = await fs.open(temporary, "wx", 0o600);
        await handle.writeFile(`${JSON.stringify(record, null, 2)}\n`, "utf8");
        await handle.sync();
        await handle.close();
        handle = null;
        await fs.rename(temporary, selected);
      } finally {
        await handle?.close().catch(() : any => {});
        await fs.rm(temporary, { force: true }).catch(() : any => {});
      }
    }
  });
}

function acceptedBackupReceipt(value?: any) : any {
  return value?.ok === true &&
    typeof value.backupId === "string" &&
    value.backupId.startsWith("backup_") &&
    typeof value.receiptId === "string" &&
    value.receiptId.length > 0;
}

function acceptedValidation(value?: any) : any {
  return value?.healthy === true && value?.governedOperationOk === true;
}

export async function executeEnterpriseUpgradeRollback({
  candidateImage,
  previousImage,
  candidate,
  backup,
  activation,
  validation,
  restore,
  journal
}: Record<string, any> = {}) : Promise<any> {
  const candidateRef: any = imageReference(
    candidateImage,
    "enterprise_upgrade_candidate_digest_required"
  );
  const previousRef: any = imageReference(
    previousImage,
    "enterprise_upgrade_previous_digest_required"
  );
  if (candidateRef === previousRef) {
    throw upgradeError(
      "enterprise_upgrade_candidate_must_differ",
      "Upgrade candidate must differ from the previous image."
    );
  }
  for (const [owner, method] of [
    [candidate, "admit"],
    [backup, "create"],
    [activation, "activate"],
    [validation, "check"],
    [restore, "preview"],
    [restore, "apply"],
    [journal, "write"]
  ]) requirePort(owner, method);

  const state: Record<string, any> = {
    schemaVersion: JOURNAL_SCHEMA,
    candidateImage: candidateRef,
    previousImage: previousRef,
    phase: "preflight",
    backupId: "",
    backupReceiptId: "",
    outcome: "pending"
  };
  const publish: any = async (phase?: any, fields: Record<string, any> = {}) : Promise<any> => {
    Object.assign(state, fields, { phase });
    await journal.write({ ...state });
  };

  await publish("preflight");
  await candidate.admit(candidateRef);
  await publish("candidate-admitted");
  const backupReceipt: any = await backup.create();
  if (!acceptedBackupReceipt(backupReceipt)) {
    throw upgradeError(
      "enterprise_upgrade_backup_receipt_invalid",
      "Upgrade backup did not produce an accepted receipt."
    );
  }
  await publish("backup-created", {
    backupId: backupReceipt.backupId,
    backupReceiptId: backupReceipt.receiptId
  });

  try {
    await activation.activate(candidateRef);
    await publish("candidate-activated");
    const candidateValidation: any = await validation.check(candidateRef);
    if (!acceptedValidation(candidateValidation)) {
      throw upgradeError(
        "enterprise_upgrade_candidate_validation_failed",
        "Upgrade candidate failed bounded health or governed-operation validation."
      );
    }
    await publish("complete", { outcome: "upgraded" });
    return Object.freeze({
      ok: true,
      outcome: "upgraded",
      candidateImage: candidateRef,
      previousImage: previousRef,
      backupId: backupReceipt.backupId
    });
  } catch (upgradeFailure: any) {
    try {
      await publish("rollback-started", {
        outcome: "rollback-pending",
        failureCode: String(upgradeFailure?.code || "enterprise_upgrade_candidate_failed")
      });
      await activation.activate(previousRef);
      await publish("previous-image-reactivated");
      const preview: any = await restore.preview(backupReceipt.backupId);
      if (preview?.ok !== true || preview?.integrityVerified !== true) {
        throw upgradeError(
          "enterprise_upgrade_restore_preview_failed",
          "Upgrade rollback restore preview failed."
        );
      }
      const restored: any = await restore.apply(backupReceipt.backupId);
      if (restored?.ok !== true || restored?.applied !== true) {
        throw upgradeError(
          "enterprise_upgrade_restore_failed",
          "Upgrade rollback restore failed."
        );
      }
      await publish("state-restored");
      const previousValidation: any = await validation.check(previousRef);
      if (!acceptedValidation(previousValidation)) {
        throw upgradeError(
          "enterprise_upgrade_rollback_validation_failed",
          "The prior version failed validation after rollback."
        );
      }
      await publish("complete", { outcome: "rolled-back" });
      return Object.freeze({
        ok: false,
        outcome: "rolled-back",
        candidateImage: candidateRef,
        previousImage: previousRef,
        backupId: backupReceipt.backupId,
        failureCode: String(upgradeFailure?.code || "enterprise_upgrade_candidate_failed")
      });
    } catch (rollbackFailure: any) {
      await publish("in-doubt", {
        outcome: "in_doubt",
        rollbackFailureCode: String(
          rollbackFailure?.code || "enterprise_upgrade_rollback_failed"
        )
      }).catch(() : any => {});
      throw upgradeError(
        "enterprise_upgrade_rollback_in_doubt",
        "Upgrade rollback is in doubt and must not be retried blindly.",
        rollbackFailure
      );
    }
  }
}
