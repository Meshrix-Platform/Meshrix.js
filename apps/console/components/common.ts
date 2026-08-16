import BinaryCheckbox from "@meshrix/ui-console/binary-checkbox";
import BridgeDownloadButton from "./BridgeDownloadButton.vue";
import BrowseSelectButton from "./BrowseSelectButton.vue";
import ConfigFloatingPanel from "./ConfigFloatingPanel.vue";
import ConfigFoldCard from "./ConfigFoldCard.vue";
import ConfigListSummaryBubble from "./ConfigListSummaryBubble.vue";
import ConsoleConfirmDialog from "./ConsoleConfirmDialog.vue";
import ConsoleDescriptionList from "./ConsoleDescriptionList.vue";
import ConsoleEmptyState from "./ConsoleEmptyState.vue";
import ConsoleInlineAlert from "./ConsoleInlineAlert.vue";
import ConsoleSkeleton from "./ConsoleSkeleton.vue";
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
import StatusPill from "@meshrix/ui-console/status-pill";
import UploadFileListCard from "./UploadFileListCard.vue";
import WorkspaceFileTree from "./WorkspaceFileTree.vue";

export { BinaryCheckbox, BridgeDownloadButton, BrowseSelectButton, ConfigFloatingPanel, ConfigFoldCard, ConfigListSummaryBubble, ConsoleConfirmDialog, ConsoleDescriptionList, ConsoleEmptyState, ConsoleInlineAlert, ConsoleSkeleton, ConsoleToastHost, DataTable, FeatureToggle, HelpTooltip, HistorySessionPanel, JsonConfigFileEditor, MeshrixTabs, MultiChoiceCardGroup, OptionBar, SafeHtmlBlock, ScopeSelector, SegmentedProgressBar, SegmentedToggle, SplitToggleCard, StatusPill, UploadFileListCard, WorkspaceFileTree };

export type CommonComponentRegistration = {
  name: string;
  file: string;
  /** Component ownership tier: Tier 1 = packages/ui-console/src primitive, Tier 2 = console commons (components root). */
  tier: "1" | "2";
  category: "choice" | "picker" | "history" | "result" | "config" | "render" | "progress" | "feedback" | "action";
  description: string;
  usageRule: string;
};

export const commonComponentReusePolicy: any = [
  "能用通用组件就用通用组件，功能页面不得重新手写已有语义覆盖的控件。",
  "能继承就继承，页面级样式只负责布局、间距和局部状态组合。",
  "新场景优先扩展通用组件的 props、slot 或 token 化样式；语义无法覆盖时才新增组件并登记到本注册表。",
] as const;

export const commonComponentRegistry: CommonComponentRegistration[] = [
  {
    name: "BinaryCheckbox",
    file: "packages/ui-console/src/BinaryCheckbox.vue",
    tier: "1",
    category: "choice",
    description: "独立布尔选项的标准复选控件。",
    usageRule: "页面需要复选框式布尔开关时使用；不要替代胶囊型二态 Toggle。",
  },
  {
    name: "OptionBar",
    file: "packages/ui-console/src/OptionBar.vue",
    tier: "1",
    category: "choice",
    description: "选项栏的标准选择控件外壳。",
    usageRule: "页面需要下拉选项栏时使用；选项列表和值必须由调用方传入，组件不得写默认功能值。",
  },
  {
    name: "FeatureToggle",
    file: "apps/console/components/FeatureToggle.vue",
    tier: "2",
    category: "choice",
    description: "功能、模块、授权等启停状态的标准胶囊 Toggle。",
    usageRule: "页面需要表达某个功能是否开启并允许直接启停时使用；组件只发出布尔值，启停逻辑和保存行为由调用方绑定。",
  },
  {
    name: "StatusPill",
    file: "packages/ui-console/src/StatusPill.vue",
    tier: "1",
    category: "result",
    description: "状态展示的标准圆点胶囊。",
    usageRule: "页面需要展示运行状态、配置状态、风险等级或启用状态时使用；只传入 label/tone/enabled，不在功能页面手写状态胶囊。",
  },
  {
    name: "BrowseSelectButton",
    file: "apps/console/components/BrowseSelectButton.vue",
    tier: "2",
    category: "picker",
    description: "文件、文件夹、本地路径选择入口。",
    usageRule: "页面需要触发浏览文件、文件夹或本地路径选择时使用，按钮文案和选择类型由调用方传入。",
  },
  {
    name: "ConfigFloatingPanel",
    file: "apps/console/components/ConfigFloatingPanel.vue",
    tier: "2",
    category: "config",
    description: "可编辑配置弹层的标准外壳，统一标题、副标题、状态、校验按钮、关闭行为和滚动容器。",
    usageRule: "页面需要新增或修改配置时使用；功能页面通过 slot 传入输入框、选择框、校验结果和保存按钮，不重复手写弹层外壳。",
  },
  {
    name: "ConfigListSummaryBubble",
    file: "apps/console/components/ConfigListSummaryBubble.vue",
    tier: "2",
    category: "config",
    description: "配置项只读概览气泡，统一锚点定位、关闭行为、分组列表和值状态展示。",
    usageRule: "页面只需要快速查看配置来源和值时使用；需要修改配置时使用 ConfigFloatingPanel。",
  },
  {
    name: "ConfigFoldCard",
    file: "apps/console/components/ConfigFoldCard.vue",
    tier: "2",
    category: "config",
    description: "配置、JSON、运行结构和诊断信息的标准折叠卡片。",
    usageRule: "页面需要展开/收起配置、JSON、诊断结构或详情时使用；具体表单、JSON 和数据内容由调用方通过 slot 提供。",
  },
  {
    name: "JsonConfigFileEditor",
    file: "apps/console/components/JsonConfigFileEditor.vue",
    tier: "2",
    category: "config",
    description: "真实配置文件 JSON 的标准单例编辑框，统一展示、编辑、取消、保存和 JSON 校验。",
    usageRule: "页面需要展示或编辑 JSON/配置文件内容时使用；必须传入稳定 fileKey 和保存回调，不在功能页面手写 textarea/pre 保存按钮。",
  },
  {
    name: "ConsoleFormField",
    file: "apps/console/components/ConsoleFormField.vue",
    tier: "2",
    category: "config",
    description: "表单字段的标准外壳，统一标签、必填标记、帮助文本和错误提示的 label/for/id/aria 接线。",
    usageRule: "任何表单输入项都必须使用；默认 slot 放入唯一控件并以 v-slot/v-bind 接收 id 与 aria 属性，错误与帮助文案由调用方传入，不在功能页面手写 label+input 包装。",
  },
  {
    name: "ConsoleFormValidation",
    file: "apps/console/composables/console-form-validation.ts",
    tier: "2",
    category: "config",
    description: "逐字段表单错误状态存储，按字段名键控，配合 ConsoleFormField 展示错误。",
    usageRule: "每个表单实例创建一个；规则校验失败时用 setFieldError 写入逐字段错误，提交前读取 hasErrors，不在页面内散落错误布尔值。",
  },
  {
    name: "HistorySessionPanel",
    file: "apps/console/components/HistorySessionPanel.vue",
    tier: "2",
    category: "history",
    description: "可折叠、可选择、可删除的历史会话和运行记录列表。",
    usageRule: "对话框或操作框需要补充历史会话、历史记录或可恢复运行列表时使用；默认收缩，列表数据和删除行为由调用方绑定。",
  },
  {
    name: "SafeHtmlBlock",
    file: "apps/console/components/SafeHtmlBlock.vue",
    tier: "2",
    category: "render",
    description: "已净化或沙箱化 HTML 的唯一页面渲染边界。",
    usageRule: "页面需要渲染 HTML 时使用；调用方必须传入由 markdownToSafeHtml 或 renderEvidenceReadableHtml 生成的内容，并声明 source。",
  },
  {
    name: "SegmentedToggle",
    file: "apps/console/components/SegmentedToggle.vue",
    tier: "2",
    category: "choice",
    description: "多选项平铺分段控制器组件。",
    usageRule: "页面需要分段切换视图或选项时使用，替代零散的 tabs 样式或 el-radio-group。",
  },
  {
    name: "SegmentedProgressBar",
    file: "apps/console/components/SegmentedProgressBar.vue",
    tier: "2",
    category: "progress",
    description: "标准分段式进度条，支持步骤标签和 pending/active/complete/failed 状态。",
    usageRule: "页面需要按步骤展示进度时使用；功能页面只传步骤数据，不重新手写分段条 DOM 或颜色状态。",
  },
  {
    name: "ConsoleSkeleton",
    file: "apps/console/components/ConsoleSkeleton.vue",
    tier: "2",
    category: "progress",
    description: "加载占位的标准骨架组件，统一映射既有 skeleton 工具类。",
    usageRule: "加载占位统一使用 ConsoleSkeleton；不手写 skeleton 标记。",
  },
  {
    name: "ConsoleToastHost",
    file: "apps/console/components/ConsoleToastHost.vue",
    tier: "2",
    category: "feedback",
    description: "全局瞬时反馈通知宿主，统一 info/success/danger 三档语气、自动消退和堆叠动效。",
    usageRule: "操作成功、失败或需要轻量提醒时通过 pushConsoleToast/notifyConsoleAction 触发；页面不得手写悬浮通知或使用浏览器 alert。可逆的本地草稿操作通过 action（label + run）提供撤销入口，danger 通知默认常驻不自动消退；不得在服务端治理效果上提供撤销。",
  },
  {
    name: "ConsoleConfirmDialog",
    file: "apps/console/components/ConsoleConfirmDialog.vue",
    tier: "2",
    category: "feedback",
    description: "全局操作确认对话框，统一标题、语气、按钮和可选的输入确认，Promise 化返回用户选择。",
    usageRule: "删除、覆盖、撤销等需要用户确认的操作通过 confirmConsoleAction/requestConsoleConfirm 触发；不得使用浏览器 confirm 或自研局部确认弹窗。",
  },
  {
    name: "ConsoleDescriptionList",
    file: "apps/console/components/ConsoleDescriptionList.vue",
    tier: "2",
    category: "result",
    description: "键值详情的标准描述列表，统一标签、取值、等宽字体和响应式列布局。",
    usageRule: "页面需要展示只读的标签/取值详情（运行实例、报告元信息、路径等）时使用；不得再用裸 dl/dt/dd 平铺文字。",
  },
  {
    name: "ConsoleEmptyState",
    file: "apps/console/components/ConsoleEmptyState.vue",
    tier: "2",
    category: "feedback",
    description: "列表、面板、树或查询结果为空时的标准占位，统一图标、标题、描述、compact 与 danger 变体，并通过 action 插槽承载起步操作。",
    usageRule: "任何空结果、空权限或未选择占位都必须使用；已知下一步时用 action 插槽给出可点击入口，不要把下一步写成描述文字里的页面名；不得再手写 empty-state/empty-copy 等局部空态类名。",
  },
  {
    name: "ConsoleInlineAlert",
    file: "apps/console/components/ConsoleInlineAlert.vue",
    tier: "2",
    category: "feedback",
    description: "区块级行内状态提示条，统一 info/success/danger 三档语义色与可读性，并通过 action 插槽承载重试等恢复操作。",
    usageRule: "页面区块内的错误、成功或状态反馈使用；需要重试或跳转等恢复操作时用 action 插槽，不要在页面内自写提示条与按钮的并排容器；瞬时反馈用 ConsoleToastHost，不得硬编码色值自写局部 alert 样式。",
  },
  {
    name: "DataTable",
    file: "apps/console/components/DataTable.vue",
    tier: "2",
    category: "result",
    description: "Element Plus 表格的标准封装，统一边框、斑马纹、尺寸和加载态。",
    usageRule: "页面需要数据表格时优先使用；不要在页面级直接散布 ElTable 配置。",
  },
  {
    name: "MeshrixTabs",
    file: "apps/console/components/MeshrixTabs.vue",
    tier: "2",
    category: "choice",
    description: "二级页签切换标准组件，统一样式、选中态和键盘操作。",
    usageRule: "页面需要页签式二级导航时使用，不手写 tab 列表。",
  },
  {
    name: "HelpTooltip",
    file: "apps/console/components/HelpTooltip.vue",
    tier: "2",
    category: "render",
    description: "字段级帮助提示，统一触发图标、悬浮层和文案展示。",
    usageRule: "表单或配置项需要补充解释文案时使用。",
  },
  {
    name: "ScopeSelector",
    file: "apps/console/components/ScopeSelector.vue",
    tier: "2",
    category: "picker",
    description: "权限范围（scope）标准选择器。",
    usageRule: "需要选择或展示授权 scope 时使用。",
  },
  {
    name: "MultiChoiceCardGroup",
    file: "apps/console/components/MultiChoiceCardGroup.vue",
    tier: "2",
    category: "choice",
    description: "卡片形式的多选组，统一选中态与禁用态；支持 auto、stacked、fold 与仅勾选+文案的 list。",
    usageRule: "需要多项选择时使用；长列表优先 layout=\"list\"（外层复用 ConfigFoldCard，展开后为一行一项带分割线的 Checkbox 列表；需要时用 selectAllLabel 在列表首行提供全选）或 layout=\"fold\"（每项可展开说明）。",
  },
  {
    name: "SplitToggleCard",
    file: "apps/console/components/SplitToggleCard.vue",
    tier: "2",
    category: "render",
    description: "摘要加展开详情的折叠卡片，统一展开行为与内部交互隔离。",
    usageRule: "需要默认折叠、点击展开详情的卡片时使用。",
  },
  {
    name: "UploadFileListCard",
    file: "apps/console/components/UploadFileListCard.vue",
    tier: "2",
    category: "result",
    description: "上传文件列表卡片，统一文件项展示与移除行为。",
    usageRule: "需要展示待上传或已上传文件列表时使用；入库进行中的状态通过 ingesting 布尔属性传入，组件不读取全局忙状态。",
  },
  {
    name: "WorkspaceFileTree",
    file: "apps/console/components/WorkspaceFileTree.vue",
    tier: "2",
    category: "render",
    description: "工作空间文件树，统一目录结构展示与空态。",
    usageRule: "需要展示工作空间目录结构时使用。",
  },
  {
    name: "BridgeDownloadButton",
    file: "apps/console/components/BridgeDownloadButton.vue",
    tier: "2",
    category: "action",
    description: "桥接组件下载入口按钮，统一下载触发与状态展示。",
    usageRule: "需要提供桥接或客户端下载入口时使用。",
  },
];
