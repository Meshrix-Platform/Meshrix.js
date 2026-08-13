import { computed, onMounted, ref, watch } from 'vue';
import {
  getAuthorizationGovernance,
  upsertAuthorizationGovernance,
  type AuthorizationGovernanceKind,
} from '../lib/authorization-governance-client';
import { formatCompactDate } from '@meshrix/ui-console/console-format-utils';
import { usePageRefreshHandler } from "@meshrix/ui-console/page-refresh";
import { useServerConsoleShellContext } from '#meshrix/console/server-console-shell-context';

type GovernanceItem = Record<string, unknown>;

type GovernanceSummary = {
  roles: GovernanceItem[];
  departments: GovernanceItem[];
  teams: GovernanceItem[];
  userPolicies: GovernanceItem[];
  agentBindings: GovernanceItem[];
  agentGroups: GovernanceItem[];
  approvals: GovernanceItem[];
};

type GovernanceEditorKind = AuthorizationGovernanceKind;

const authorizationGovernanceEditorKinds: any = [
  { value: 'role', label: '角色' },
  { value: 'department', label: '部门' },
  { value: 'team', label: '团队' },
  { value: 'userPolicy', label: '用户策略' },
  { value: 'agentGroup', label: '智能体分组' },
  { value: 'agentBinding', label: '智能体绑定' },
  { value: 'approval', label: '审批' },
] as const;

function emptyGovernanceSummary(): GovernanceSummary {
  return {
    roles: [],
    departments: [],
    teams: [],
    userPolicies: [],
    agentBindings: [],
    agentGroups: [],
    approvals: [],
  };
}

function asList(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map((item?: any) : any => String(item || '').trim()).filter(Boolean);
  }
  if (typeof value === 'string') {
    return value.split(',').map((item?: any) : any => item.trim()).filter(Boolean);
  }
  return [];
}

function shortList(value: unknown, fallback: any = '未配置'): string {
  const items: any = asList(value);
  if (items.length === 0) return fallback;
  return items.slice(0, 3).join(', ') + (items.length > 3 ? ` +${items.length - 3}` : '');
}

function itemText(item: GovernanceItem, keys: string[], fallback: any = ''): string {
  for (const key of keys) {
    const value: any = item[key];
    if (value !== undefined && value !== null && String(value).trim()) {
      return String(value);
    }
  }
  return fallback;
}

function policyCount(item: GovernanceItem): number {
  const policies: any = item.resourcePolicies;
  return Array.isArray(policies) ? policies.length : 0;
}

function governanceEditorSample(kind: GovernanceEditorKind): string {
  const samples: any = {
    role: {
      roleId: 'repo-maintainer',
      label: 'Repo Maintainer',
      scopes: ['repo:read', 'repo:write', 'repo:maintain'],
      resourcePolicies: [{ resourceType: 'repo', resourceId: 'owner/repo', actions: ['repo:write'], targetProviders: ['github'] }],
    },
    department: {
      departmentId: 'department-platform',
      label: 'Platform Department',
      teamIds: ['team-code'],
      memberUserIds: ['console_user_id'],
      resourcePolicies: [{ resourceType: 'repo', resourceId: 'owner/repo', actions: ['repo:write', 'repo:maintain'], targetProviders: ['github'] }],
    },
    team: {
      teamId: 'team-code',
      label: 'Code Team',
      departmentIds: ['department-platform'],
      memberUserIds: ['console_user_id'],
      resourcePolicies: [{ resourceType: 'repo', resourceId: 'owner/repo', actions: ['repo:write', 'repo:maintain'], targetProviders: ['github'] }],
    },
    userPolicy: {
      userId: 'console_user_id',
      teamIds: ['team-code'],
      departmentIds: ['department-platform'],
      resourcePolicies: [{ resourceType: 'repo', resourceId: 'owner/repo', actions: ['repo:write'], targetProviders: ['github'] }],
    },
    agentGroup: {
      groupId: 'code-submitters',
      label: 'Code Submitters',
      resourcePolicies: [{ resourceType: 'repo', resourceId: 'owner/repo', actions: ['repo:write'], targetProviders: ['github'] }],
    },
    agentBinding: {
      agentId: 'agent-codex',
      boundUserId: 'console_user_id',
      groupIds: ['code-submitters'],
      resourcePolicies: [],
    },
    approval: {
      approvalId: 'approval-once',
      userId: 'console_user_id',
      agentId: 'agent-codex',
      resourceType: 'repo',
      resourceId: 'owner/repo',
      actions: ['repo:write'],
      targetProviders: ['github'],
      approvalLayers: ['user', 'agent'],
      grantKind: 'once',
    },
  } satisfies Record<GovernanceEditorKind, Record<string, unknown>>;
  return JSON.stringify(samples[kind], null, 2);
}

export function useOperationPermissionViewConsole() : any {
  const authorizationGovernance: any = ref<GovernanceSummary>(emptyGovernanceSummary());
  const authorizationGovernanceLoading: any = ref(false);
  const authorizationGovernanceError: any = ref('');
  const authorizationGovernanceSaving: any = ref(false);
  const authorizationGovernanceEditorKind: any = ref<GovernanceEditorKind>('team');
  const authorizationGovernanceEditorBody: any = ref('');
  const authorizationGovernanceEditorStatus: any = ref('');

  async function refreshAuthorizationGovernance() : Promise<any> {
    authorizationGovernanceLoading.value = true;
    authorizationGovernanceError.value = '';
    try {
      const payload: any = await getAuthorizationGovernance();
      authorizationGovernance.value = {
        ...emptyGovernanceSummary(),
        ...(payload?.governance || {}),
      };
    } catch (error: any) {
      authorizationGovernanceError.value = error instanceof Error ? error.message : '读取统一权限治理失败。';
    } finally {
      authorizationGovernanceLoading.value = false;
    }
  }

  const authorizationGovernanceMetrics: any = computed(() : any => [
    { label: '角色', value: authorizationGovernance.value.roles.length },
    { label: '部门', value: authorizationGovernance.value.departments.length },
    { label: '团队', value: authorizationGovernance.value.teams.length },
    { label: '用户策略', value: authorizationGovernance.value.userPolicies.length },
    { label: '智能体绑定', value: authorizationGovernance.value.agentBindings.length },
    { label: '审批', value: authorizationGovernance.value.approvals.length },
  ]);

  function resetAuthorizationGovernanceEditor() : any {
    authorizationGovernanceEditorBody.value = governanceEditorSample(authorizationGovernanceEditorKind.value);
    authorizationGovernanceEditorStatus.value = '';
  }

  async function saveAuthorizationGovernanceEditor() : Promise<any> {
    authorizationGovernanceSaving.value = true;
    authorizationGovernanceEditorStatus.value = '';
    authorizationGovernanceError.value = '';
    try {
      const payload: any = JSON.parse(authorizationGovernanceEditorBody.value || '{}') as Record<string, unknown>;
      await upsertAuthorizationGovernance(authorizationGovernanceEditorKind.value, payload);
      authorizationGovernanceEditorStatus.value = '已保存';
      await refreshAuthorizationGovernance();
    } catch (error: any) {
      authorizationGovernanceEditorStatus.value = error instanceof Error ? error.message : '保存失败';
    } finally {
      authorizationGovernanceSaving.value = false;
    }
  }

  watch(authorizationGovernanceEditorKind, () : any => {
    resetAuthorizationGovernanceEditor();
  });

  const {
  operationPermissionConsole,
} = useServerConsoleShellContext().operationPermission;
  const {
    isBusy,
    copyIssuedToolToken,
    createGrant,
    deleteGrant,
    enabledToolGrantCount,
    grantHasToolset,
    grantToolRuleState,
    issuedToolToken,
    newGrantLabel,
    newGrantScopes,
    newGrantToolsets,
    policyPreviewGrantId,
    policyPreviewProfileId,
    policyPreviewProfileOptionBarOptions,
    policyPreviewResult,
    policyPreviewToolId,
    policyPreviewToolOptionBarOptions,
    previewToolPolicy,
    rotateGrant,
    selectToolForManagement,
    selectedOperationPermissionTool,
    setGrantToolRule,
    toggleGrantToolset,
    toggleNewGrantToolset,
    toolGrants,
    operationPermissionTools,
    operationPermissionToolsets,
    toolScopes,
    updateGrant,
  } = operationPermissionConsole;

  function handleSelectedToolChange(event: Event) : any {
    const target: any = event.target as HTMLSelectElement | null;
    selectToolForManagement(target?.value || '');
  }

  onMounted(() : any => {
    resetAuthorizationGovernanceEditor();
    void refreshAuthorizationGovernance();
  });

  usePageRefreshHandler(
    (detail?: any) : any => detail.viewId === 'admin' && detail.adminView === 'operationPermission',
    refreshAuthorizationGovernance,
  );

  return {
    authorizationGovernance,
    authorizationGovernanceEditorBody,
    authorizationGovernanceEditorKind,
    authorizationGovernanceEditorKinds,
    authorizationGovernanceEditorStatus,
    authorizationGovernanceError,
    authorizationGovernanceLoading,
    authorizationGovernanceMetrics,
    authorizationGovernanceSaving,
    isBusy,
    copyIssuedToolToken,
    createGrant,
    deleteGrant,
    enabledToolGrantCount,
    formatCompactDate,
    grantHasToolset,
    grantToolRuleState,
    handleSelectedToolChange,
    issuedToolToken,
    itemText,
    newGrantLabel,
    newGrantScopes,
    newGrantToolsets,
    policyCount,
    policyPreviewGrantId,
    policyPreviewProfileId,
    policyPreviewProfileOptionBarOptions,
    policyPreviewResult,
    policyPreviewToolId,
    policyPreviewToolOptionBarOptions,
    previewToolPolicy,
    refreshAuthorizationGovernance,
    resetAuthorizationGovernanceEditor,
    rotateGrant,
    saveAuthorizationGovernanceEditor,
    selectedOperationPermissionTool,
    setGrantToolRule,
    shortList,
    toggleGrantToolset,
    toggleNewGrantToolset,
    toolGrants,
    operationPermissionTools,
    operationPermissionToolsets,
    toolScopes,
    updateGrant,
  };
}
