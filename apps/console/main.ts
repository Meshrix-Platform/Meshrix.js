import { createApp } from "vue";
import { ElButton } from "element-plus/es/components/button/index.mjs";
import { ElLoading } from "element-plus/es/components/loading/index.mjs";
import { ElOption, ElSelect } from "element-plus/es/components/select/index.mjs";
import { ElTable, ElTableColumn } from "element-plus/es/components/table/index.mjs";
import "element-plus/es/components/button/style/css";
import "element-plus/es/components/loading/style/css";
import "element-plus/es/components/select/style/css";
import "element-plus/es/components/table/style/css";
import "element-plus/es/components/table-column/style/css";
import { router } from "./router/index";
import ServerConsoleApp from "./ServerConsoleApp.vue";
import { readInitialConsoleLocale } from "./i18n/console";
import "./styles/index.css";

document.documentElement.lang = readInitialConsoleLocale() === "en" ? "en" : "zh-CN";
document.documentElement.setAttribute("translate", "no");
document.documentElement.classList.add("notranslate");
document.body.setAttribute("translate", "no");
document.body.classList.add("notranslate");

createApp(ServerConsoleApp)
  .use(router)
  .use(ElLoading)
  .component(ElButton.name ?? "ElButton", ElButton)
  .component(ElSelect.name ?? "ElSelect", ElSelect)
  .component(ElOption.name ?? "ElOption", ElOption)
  .component(ElTable.name ?? "ElTable", ElTable)
  .component(ElTableColumn.name ?? "ElTableColumn", ElTableColumn)
  .mount("#root");
