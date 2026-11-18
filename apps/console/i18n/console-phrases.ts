import type { ConsolePhrasePair } from './console-phrase-types';
import { debugPhrasePairs } from './console-phrases/debug';
import { governanceWorkspacesPhrasePairs } from './console-phrases/governance-workspaces';
import { opsProductionPhrasePairs } from './console-phrases/ops-production';
import { shellCorePhrasePairs } from './console-phrases/shell-core';
import { upstreamServicePublishingPhrasePairs } from './console-phrases/upstream-service-publishing';
export type { ConsolePhrasePair } from './console-phrase-types';
export { consoleSegmentPairs } from './console-phrases/segments';

export const consolePhrasePairs: ConsolePhrasePair[] = [
  ...shellCorePhrasePairs,
  ...debugPhrasePairs,
  ...governanceWorkspacesPhrasePairs,
  ...opsProductionPhrasePairs,
  ...upstreamServicePublishingPhrasePairs,
];
