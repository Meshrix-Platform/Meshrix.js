export type ModelUsageDefinition = {
  readonly id: string;
  readonly label: string;
  readonly designedModule: string;
  readonly description: string;
  readonly requiresIntelligence: boolean;
  readonly alertRequired: boolean;
};

export const MODEL_USAGE_DEFINITIONS: readonly ModelUsageDefinition[];
export const MODEL_USAGE_DEFINITION_IDS: readonly string[];
