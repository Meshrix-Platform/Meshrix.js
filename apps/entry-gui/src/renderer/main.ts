import { createApp } from "vue";

import App from "./App.vue";
import { startStore } from "./store.ts";

startStore();
createApp(App).mount("#app");
