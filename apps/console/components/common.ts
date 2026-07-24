import BinaryCheckbox from "@meshrix/ui-console/binary-checkbox";
import AgentModelOptionBar from "./AgentModelOptionBar.vue";
import BridgeDownloadButton from "./BridgeDownloadButton.vue";
import BrowseSelectButton from "./BrowseSelectButton.vue";
import ConfigFloatingPanel from "./ConfigFloatingPanel.vue";
import ConfigFoldCard from "./ConfigFoldCard.vue";
import ConfigListSummaryBubble from "./ConfigListSummaryBubble.vue";
import ConsoleConfirmDialog from "./ConsoleConfirmDialog.vue";
import ConsoleDescriptionList from "./ConsoleDescriptionList.vue";
import ConsoleEmptyState from "./ConsoleEmptyState.vue";
import ConsoleInlineAlert from "./ConsoleInlineAlert.vue";
import ConsoleToastHost from "./ConsoleToastHost.vue";
import DataTable from "./DataTable.vue";
import FeatureToggle from "./FeatureToggle.vue";
import HelpTooltip from "./HelpTooltip.vue";
import HistorySessionPanel from "./HistorySessionPanel.vue";
import JsonConfigFileEditor from "./JsonConfigFileEditor.vue";
import MeshrixTabs from "./MeshrixTabs.vue";
import MultiChoiceCardGroup from "./MultiChoiceCardGroup.vue";
import OptionBar from "@meshrix/ui-console/option-bar";
import SafeHtmlBlock from "./SafeHtmlBlock.vue";
import ScopeSelector from "./ScopeSelector.vue";
import SegmentedProgressBar from "./SegmentedProgressBar.vue";
import SegmentedToggle from "./SegmentedToggle.vue";
import SplitToggleCard from "./SplitToggleCard.vue";
import StatusPill from "./StatusPill.vue";
import UploadFileListCard from "./UploadFileListCard.vue";
import WorkspaceFileTree from "./WorkspaceFileTree.vue";

export { AgentModelOptionBar, BinaryCheckbox, BridgeDownloadButton, BrowseSelectButton, ConfigFloatingPanel, ConfigFoldCard, ConfigListSummaryBubble, ConsoleConfirmDialog, ConsoleDescriptionList, ConsoleEmptyState, ConsoleInlineAlert, ConsoleToastHost, DataTable, FeatureToggle, HelpTooltip, HistorySessionPanel, JsonConfigFileEditor, MeshrixTabs, MultiChoiceCardGroup, OptionBar, SafeHtmlBlock, ScopeSelector, SegmentedProgressBar, SegmentedToggle, SplitToggleCard, StatusPill, UploadFileListCard, WorkspaceFileTree };

export type CommonComponentRegistration = {
  name: string;
  file: string;
  category: "choice" | "picker" | "history" | "result" | "config" | "render" | "progress" | "feedback" | "action";
  description: string;
  usageRule: string;
};

export const commonComponentReusePolicy = [
  "能用通用组件就用通用组件，功能页面不得重新手写已有语义覆盖的控件。",
  "能继承就继承，页面级样式只负责布局、间距和局部状态组合。",
  "新场景优先扩展通用组件的 props、slot 或 token 化样式；语义无法覆盖时才新增组件并登记到本注册表。",
] as const;

export const commonComponentRegistry: CommonComponentRegistration[] = [
  {
    name: "BinaryCheckbox",
    file: "packages/ui-console/src/BinaryCheckbox.vue",
    category: "choice",
    description: "独立布尔选项的标准复选控件。",
    usageRule: "页面需要复选框式布尔开关时使用；不要替代胶囊型二态 Toggle。",
  },
  {
    name: "OptionBar",
    file: "packages/ui-console/src/OptionBar.vue",
    category: "choice",
    description: "选项栏的标准选择控件外壳。",
    usageRule: "页面需要下拉选项栏时使用；选项列表和值必须由调用方传入，组件不得写默认功能值。",
  },
  {
    name: "AgentModelOptionBar",
    file: "apps/console/components/AgentModelOptionBar.vue",
    category: "picker",
    description: "智能体选择的标准选项框，统一候选项、空模型库入口、空值和禁用原因展示。",
    usageRule: "页面需要选择已有智能体时使用；功能页面只提供候选源，不重复实现智能体选项渲染或空库跳转。",
  },
  {
    name: "FeatureToggle",
    file: "apps/console/components/FeatureToggle.vue",
    category: "choice",
    description: "功能、模块、授权等启停状态的标准胶囊 Toggle。",
    usageRule: "页面需要表达某个功能是否开启并允许直接启停时使用；组件只发出布尔值，启停逻辑和保存行为由调用方绑定。",
  },
  {
    name: "StatusPill",
    file: "apps/console/components/StatusPill.vue",
    category: "result",
    description: "状态展示的标准圆点胶囊。",
    usageRule: "页面需要展示运行状态、配置状态、风险等级或启用状态时使用；只传入 label/tone/enabled，不在功能页面手写状态胶囊。",
  },
  {
    name: "BrowseSelectButton",
    file: "apps/console/components/BrowseSelectButton.vue",
    category: "picker",
    description: "文件、文件夹、本地路径选择入口。",
    usageRule: "页面需要触发浏览文件、文件夹或本地路径选择时使用，按钮文案和选择类型由调用方传入。",
  },
  {
    name: "ConfigFloatingPanel",
    file: "apps/console/components/ConfigFloatingPanel.vue",
    category: "config",
    description: "可编辑配置弹层的标准外壳，统一标题、副标题、状态、校验按钮、关闭行为和滚动容器。",
    usageRule: "页面需要新增或修改配置时使用；功能页面通过 slot 传入输入框、选择框、校验结果和保存按钮，不重复手写弹层外壳。",
  },
  {
    name: "ConfigListSummaryBubble",
    file: "apps/console/components/ConfigListSummaryBubble.vue",
    category: "config",
    description: "配置项只读概览气泡，统一锚点定位、关闭行为、分组列表和值状态展示。",
    usageRule: "页面只需要快速查看配置来源和值时使用；需要修改配置时使用 ConfigFloatingPanel。",
  },
  {
    name: "ConfigFoldCard",
    file: "apps/console/components/ConfigFoldCard.vue",
    category: "config",
    description: "配置、JSON、运行结构和诊断信息的标准折叠卡片。",
    usageRule: "页面需要展开/收起配置、JSON、诊断结构或详情时使用；具体表单、JSON 和数据内容由调用方通过 slot 提供。",
  },
  {
    name: "JsonConfigFileEditor",
    file: "apps/console/components/JsonConfigFileEditor.vue",
    category: "config",
    description: "真实配置文件 JSON 的标准单例编辑框，统一展示、编辑、取消、保存和 JSON 校验。",
    usageRule: "页面需要展示或编辑 JSON/配置文件内容时使用；必须传入稳定 fileKey 和保存回调，不在功能页面手写 textarea/pre 保存按钮。",
  },
  {
    name: "HistorySessionPanel",
    file: "apps/console/components/HistorySessionPanel.vue",
    category: "history",
    description: "可折叠、可选择、可删除的历史会话和运行记录列表。",
    usageRule: "对话框或操作框需要补充历史会话、历史记录或可恢复运行列表时使用；默认收缩，列表数据和删除行为由调用方绑定。",
  },
  {
    name: "SafeHtmlBlock",
    file: "apps/console/components/SafeHtmlBlock.vue",
    category: "render",
    description: "已净化或沙箱化 HTML 的唯一页面渲染边界。",
    usageRule: "页面需要渲染 HTML 时使用；调用方必须传入由 markdownToSafeHtml 或 renderEvidenceReadableHtml 生成的内容，并声明 source。",
  },
  {
    name: "SegmentedToggle",
    file: "apps/console/components/SegmentedToggle.vue",
    category: "choice",
    description: "多选项平铺分段控制器组件。",
    usageRule: "页面需要分段切换视图或选项时使用，替代零散的 tabs 样式或 el-radio-group。",
  },
  {
    name: "SegmentedProgressBar",
    file: "apps/console/components/SegmentedProgressBar.vue",
    category: "progress",
    description: "标准分段式进度条，支持步骤标签和 pending/active/complete/failed 状态。",
    usageRule: "页面需要按步骤展示进度时使用；功能页面只传步骤数据，不重新手写分段条 DOM 或颜色状态。",
  },
  {
    name: "ConsoleToastHost",
    file: "apps/console/components/ConsoleToastHost.vue",
    category: "feedback",
    description: "全局瞬时反馈通知宿主，统一 info/success/danger 三档语气、自动消退和堆叠动效。",
    usageRule: "操作成功、失败或需要轻量提醒时通过 pushConsoleToast/notifyConsoleAction 触发；页面不得手写悬浮通知或使用浏览器 alert。",
  },
  {
    name: "ConsoleConfirmDialog",
    file: "apps/console/components/ConsoleConfirmDialog.vue",
    category: "feedback",
    description: "全局操作确认对话框，统一标题、语气、按钮和可选的输入确认，Promise 化返回用户选择。",
    usageRule: "删除、覆盖、撤销等需要用户确认的操作通过 confirmConsoleAction/requestConsoleConfirm 触发；不得使用浏览器 confirm 或自研局部确认弹窗。",
  },
  {
    name: "ConsoleDescriptionList",
    file: "apps/console/components/ConsoleDescriptionList.vue",
    category: "result",
    description: "键值详情的标准描述列表，统一标签、取值、等宽字体和响应式列布局。",
    usageRule: "页面需要展示只读的标签/取值详情（运行实例、报告元信息、路径等）时使用；不得再用裸 dl/dt/dd 平铺文字。",
  },
  {
    name: "ConsoleEmptyState",
    file: "apps/console/components/ConsoleEmptyState.vue",
    category: "feedback",
    description: "列表、面板、树或查询结果为空时的标准占位，统一图标、标题、描述、compact 与 danger 变体。",
    usageRule: "任何空结果、空权限或未选择占位都必须使用；不得再手写 empty-state/empty-copy 等局部空态类名。",
  },
  {
    name: "ConsoleInlineAlert",
    file: "apps/console/components/ConsoleInlineAlert.vue",
    category: "feedback",
    description: "区块级行内状态提示条，统一 info/success/danger 三档语义色与可读性。",
    usageRule: "页面区块内的错误、成功或状态反馈使用；瞬时反馈用 ConsoleToastHost，不得硬编码色值自写局部 alert 样式。",
  },
  {
    name: "DataTable",
    file: "apps/console/components/DataTable.vue",
    category: "result",
    description: "Element Plus 表格的标准封装，统一边框、斑马纹、尺寸和加载态。",
    usageRule: "页面需要数据表格时优先使用；不要在页面级直接散布 ElTable 配置。",
  },
  {
    name: "MeshrixTabs",
    file: "apps/console/components/MeshrixTabs.vue",
    category: "choice",
    description: "二级页签切换标准组件，统一样式、选中态和键盘操作。",
    usageRule: "页面需要页签式二级导航时使用，不手写 tab 列表。",
  },
  {
    name: "HelpTooltip",
    file: "apps/console/components/HelpTooltip.vue",
    category: "render",
    description: "字段级帮助提示，统一触发图标、悬浮层和文案展示。",
    usageRule: "表单或配置项需要补充解释文案时使用。",
  },
  {
    name: "ScopeSelector",
    file: "apps/console/components/ScopeSelector.vue",
    category: "picker",
    description: "权限范围（scope）标准选择器。",
    usageRule: "需要选择或展示授权 scope 时使用。",
  },
  {
    name: "MultiChoiceCardGroup",
    file: "apps/console/components/MultiChoiceCardGroup.vue",
    category: "choice",
    description: "卡片形式的多选组，统一选中态与禁用态。",
    usageRule: "需要以卡片形式进行多项选择时使用。",
  },
  {
    name: "SplitToggleCard",
    file: "apps/console/components/SplitToggleCard.vue",
    category: "render",
    description: "摘要加展开详情的折叠卡片，统一展开行为与内部交互隔离。",
    usageRule: "需要默认折叠、点击展开详情的卡片时使用。",
  },
  {
    name: "UploadFileListCard",
    file: "apps/console/components/UploadFileListCard.vue",
    category: "result",
    description: "上传文件列表卡片，统一文件项展示与移除行为。",
    usageRule: "需要展示待上传或已上传文件列表时使用。",
  },
  {
    name: "WorkspaceFileTree",
    file: "apps/console/components/WorkspaceFileTree.vue",
    category: "render",
    description: "工作空间文件树，统一目录结构展示与空态。",
    usageRule: "需要展示工作空间目录结构时使用。",
  },
  {
    name: "BridgeDownloadButton",
    file: "apps/console/components/BridgeDownloadButton.vue",
    category: "action",
    description: "桥接组件下载入口按钮，统一下载触发与状态展示。",
    usageRule: "需要提供桥接或客户端下载入口时使用。",
  },
];
