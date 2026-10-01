/**
 * Compile-time boundary fixtures for the published upstream service contract.
 *
 * This file is typechecked by `tsconfig.tests.json` and is never executed.
 * Negative cases assert that contradictory publication variants and malformed
 * public commands fail to compile; positive cases keep the intended shapes
 * anchored for the Agents producer, the runtime transport and the Console
 * client.
 */
import { createUpstreamPublishingApplication } from "#meshrix/agents/upstream-gateway/index";
import type { UpstreamPublishingApplication } from "#meshrix/agents/upstream-gateway/index";
import {
  UPSTREAM_PUBLISHING_COMMAND_SCHEMA_VERSION,
} from "@meshrix/contracts/upstream-service-publishing";
import type {
  PublishedUpstreamServiceDetail,
  PublishedUpstreamServiceSummary,
  UpstreamServiceCreateCommand,
  UpstreamServiceDescriptor,
  UpstreamServiceDetailResponse,
  UpstreamServiceDisableCommand,
  UpstreamServiceListResponse,
  UpstreamServicePublication,
  UpstreamServicePublishingCommand,
  UpstreamServicePublishingPublication,
  UpstreamServicePublishingResult,
  UpstreamServiceRemoveCommand,
  UpstreamServiceRepublishCommand,
  UpstreamServiceReplaceCommand,
  UpstreamServiceServerPublishedPublication,
} from "@meshrix/contracts/upstream-service-publishing";

declare const applicationOptions: Record<string, any>;
declare const application: UpstreamPublishingApplication;

const descriptor: UpstreamServiceDescriptor = {
  serviceProtocol: "http",
  label: "Inventory",
  baseUrl: "https://service.invalid:443",
  operations: [{
    operationKey: "lookup",
    method: "GET",
    path: "/items",
    requiredScopes: ["inventory:read"],
    payloadTransport: {
      request: {
        mode: "structured_json",
        maxBytes: 4096,
        mediaTypes: ["application/json"]
      }
    }
  }]
};

const createCommand: UpstreamServiceCreateCommand = {
  schemaVersion: UPSTREAM_PUBLISHING_COMMAND_SCHEMA_VERSION,
  action: "create",
  serviceKey: "inventory",
  expectedServiceRevision: 0,
  expectedSetRevision: 4,
  idempotencyKey: "create:fixture",
  descriptor
};

const replaceCommand: UpstreamServiceReplaceCommand = {
  schemaVersion: UPSTREAM_PUBLISHING_COMMAND_SCHEMA_VERSION,
  action: "replace",
  serviceId: "svc_fixture",
  expectedServiceRevision: 1,
  expectedSetRevision: 5,
  idempotencyKey: "replace:fixture",
  descriptor
};

const disableCommand: UpstreamServiceDisableCommand = {
  schemaVersion: UPSTREAM_PUBLISHING_COMMAND_SCHEMA_VERSION,
  action: "disable",
  serviceId: "svc_fixture",
  expectedServiceRevision: 1,
  expectedSetRevision: 5,
  idempotencyKey: "disable:fixture"
};

const removeCommand: UpstreamServiceRemoveCommand = {
  schemaVersion: UPSTREAM_PUBLISHING_COMMAND_SCHEMA_VERSION,
  action: "remove",
  serviceId: "svc_fixture",
  expectedServiceRevision: 2,
  expectedSetRevision: 6,
  idempotencyKey: "remove:fixture"
};

const republishCommand: UpstreamServiceRepublishCommand = {
  schemaVersion: UPSTREAM_PUBLISHING_COMMAND_SCHEMA_VERSION,
  action: "republish",
  serviceId: "svc_fixture",
  expectedServiceRevision: 2,
  expectedSetRevision: 6,
  idempotencyKey: "republish:fixture"
};

const commands: UpstreamServicePublishingCommand[] = [
  createCommand,
  replaceCommand,
  disableCommand,
  removeCommand,
  republishCommand
];

const queuedPublication: UpstreamServicePublishingPublication = {
  publicationRef: "urn:meshrix:upstream-publication:fixture",
  status: "publishing",
  candidateRevision: 1,
  candidateDigest: "digest"
};

const serverPublishedPublication: UpstreamServiceServerPublishedPublication = {
  publicationRef: "urn:meshrix:upstream-publication:fixture",
  status: "server_published",
  candidateRevision: 1,
  candidateDigest: "digest",
  terminal: {
    sourceRevision: 1,
    sourceDigest: "digest",
    catalogRevision: "catalog-revision",
    audienceRevision: 3,
    protocolRevision: 3
  }
};

const publications: UpstreamServicePublication[] = [queuedPublication, serverPublishedPublication];

const accepted: UpstreamServicePublishingResult = {
  ok: true,
  serviceId: "svc_fixture",
  state: "publishing",
  serviceRevision: 1,
  setRevision: 1,
  manifestDigest: "digest",
  receiptRef: "urn:meshrix:receipt:fixture",
  publication: queuedPublication,
  replayed: false
};

const summary: PublishedUpstreamServiceSummary = {
  serviceId: "svc_fixture",
  state: "disabled",
  serviceRevision: 2,
  manifestDigest: "digest",
  publication: serverPublishedPublication
};

const detail: PublishedUpstreamServiceDetail = {
  ...summary,
  descriptor: null,
  references: []
};

const listResponse: UpstreamServiceListResponse = {
  ok: true,
  setRevision: 2,
  services: [summary]
};

const detailResponse: UpstreamServiceDetailResponse = {
  ok: true,
  setRevision: 2,
  service: detail
};

export async function producerAndTransportUseSharedShapes(): Promise<void> {
  const created: UpstreamServicePublishingResult = await application.execute(
    JSON.stringify(createCommand),
    { subjectId: "fixture-developer", scopes: ["gateway:write", "gateway:maintain"] },
    { expectedAction: "create", expectedServiceId: "svc_fixture", signal: null }
  );
  const listed: UpstreamServiceListResponse = await application.list(
    { subjectId: "fixture-developer", scopes: ["gateway:read"] },
    { signal: null }
  );
  const loaded: UpstreamServiceDetailResponse = await application.get(
    "svc_fixture",
    { subjectId: "fixture-developer", scopes: ["gateway:read"] }
  );
  const typedApplication: UpstreamPublishingApplication = createUpstreamPublishingApplication(applicationOptions);
  const strings: string[] = [created.receiptRef, listed.services[0]?.serviceId || "", loaded.service.serviceId];
  void [commands, publications, accepted, listResponse, detailResponse, typedApplication, strings];
}

export function contradictoryPublicationVariants(): void {
  // @ts-expect-error the accepted mutation receipt is always in progress
  const contradictoryResult: UpstreamServicePublishingResult = { ok: true, serviceId: "svc_fixture", state: "publishing", serviceRevision: 1, setRevision: 1, manifestDigest: "digest", receiptRef: "urn:fixture", publication: serverPublishedPublication, replayed: false };
  // @ts-expect-error a queued mutation cannot carry server terminal facts
  const queuedWithTerminal: UpstreamServicePublishingPublication = { publicationRef: "urn:fixture", status: "publishing", candidateRevision: 1, candidateDigest: "digest", terminal: { sourceRevision: 1, sourceDigest: "digest", catalogRevision: "catalog", audienceRevision: 1, protocolRevision: 1 } };
  // @ts-expect-error server_published requires terminal facts
  const publishedWithoutTerminal: UpstreamServicePublication = { publicationRef: "urn:fixture", status: "server_published", candidateRevision: 1, candidateDigest: "digest" };
  // @ts-expect-error accepted results are always ok=true
  const rejectedResult: UpstreamServicePublishingResult = { ok: false, serviceId: "svc_fixture", state: "publishing", serviceRevision: 1, setRevision: 1, manifestDigest: "digest", receiptRef: "urn:fixture", publication: queuedPublication, replayed: false };
  // @ts-expect-error durable service state is publishing, disabled, or removed
  const inventedState: PublishedUpstreamServiceSummary = { serviceId: "svc_fixture", state: "accepted", serviceRevision: 1, manifestDigest: "digest", publication: queuedPublication };
  // @ts-expect-error a model that narrows to server_published cannot read a queued publication's terminal facts
  const terminal = accepted.publication.terminal;
  void [contradictoryResult, queuedWithTerminal, publishedWithoutTerminal, rejectedResult, inventedState, terminal];
}

export function malformedPublicCommands(): void {
  // @ts-expect-error create requires a descriptor
  const missingDescriptor: UpstreamServiceCreateCommand = { schemaVersion: UPSTREAM_PUBLISHING_COMMAND_SCHEMA_VERSION, action: "create", serviceKey: "inventory", expectedServiceRevision: 0, expectedSetRevision: 0, idempotencyKey: "create:fixture" };
  // @ts-expect-error replace requires the server service id
  const missingServiceId: UpstreamServiceReplaceCommand = { schemaVersion: UPSTREAM_PUBLISHING_COMMAND_SCHEMA_VERSION, action: "replace", expectedServiceRevision: 1, expectedSetRevision: 1, idempotencyKey: "replace:fixture", descriptor };
  // @ts-expect-error disable carries no descriptor
  const disableWithDescriptor: UpstreamServiceDisableCommand = { schemaVersion: UPSTREAM_PUBLISHING_COMMAND_SCHEMA_VERSION, action: "disable", serviceId: "svc_fixture", expectedServiceRevision: 1, expectedSetRevision: 1, idempotencyKey: "disable:fixture", descriptor };
  // @ts-expect-error expected revisions are numbers
  const stringRevision: UpstreamServiceCreateCommand = { schemaVersion: UPSTREAM_PUBLISHING_COMMAND_SCHEMA_VERSION, action: "create", serviceKey: "inventory", expectedServiceRevision: 0, expectedSetRevision: "4", idempotencyKey: "create:fixture", descriptor };
  // @ts-expect-error the command action is a closed union
  const unknownAction: UpstreamServicePublishingCommand = { ...createCommand, action: "archive" };
  // @ts-expect-error the schema version is exact
  const wrongSchema: UpstreamServiceCreateCommand = { ...createCommand, schemaVersion: "v0.0.1:upstream-service-publishing:command-1" };
  // @ts-expect-error the application contract exposes only list/get/execute
  application.replaceFromManifestSnapshot();
  // @ts-expect-error expectedAction names a supported publishing action
  application.execute(JSON.stringify(createCommand), null, { expectedAction: "archive" });
  void [missingDescriptor, missingServiceId, disableWithDescriptor, stringRevision, unknownAction, wrongSchema];
}
