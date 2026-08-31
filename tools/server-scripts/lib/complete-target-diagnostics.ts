export interface TargetDiagnosticFailure {
  target: string;
  error: unknown;
}

export interface CompleteTargetDiagnosticsResult<T> {
  outcomes: T[];
  failures: TargetDiagnosticFailure[];
  executedTargets: string[];
  unexecutedTargets: string[];
}

export async function runCompleteTargetDiagnostics<T>({
  targets = [],
  runTarget,
  failureOutcome
}: {
  targets?: readonly string[];
  runTarget: (target: string) => Promise<T>;
  failureOutcome: (target: string, error: unknown) => T | Promise<T>;
}): Promise<CompleteTargetDiagnosticsResult<T>> {
  const declaredTargets = [...targets].map(String);
  const outcomes: T[] = [];
  const failures: TargetDiagnosticFailure[] = [];
  const executedTargets: string[] = [];

  for (const target of declaredTargets) {
    try {
      outcomes.push(await runTarget(target));
    } catch (error) {
      failures.push({ target, error });
      outcomes.push(await failureOutcome(target, error));
    } finally {
      executedTargets.push(target);
    }
  }

  const executed = new Set(executedTargets);
  return {
    outcomes,
    failures,
    executedTargets,
    unexecutedTargets: declaredTargets.filter((target) => !executed.has(target))
  };
}
