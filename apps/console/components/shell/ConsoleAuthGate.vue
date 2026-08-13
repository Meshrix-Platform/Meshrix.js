<script setup lang="ts">
import MeshrixJsMark from "../MeshrixJsMark.vue";
import { useServerConsoleShellContext } from "#meshrix/console/server-console-shell-context";

const {
  loginForm,
  submitLoginAuth,
} = useServerConsoleShellContext().access;
const {
  languageMode,
  msg,
  toggleLanguage,
  tt,
} = useServerConsoleShellContext().preferences;
const {
  consoleBootstrapping,
  isBusy,
} = useServerConsoleShellContext().runtime;
</script>

<template>
  <section class="auth-gate">
    <article class="surface-card auth-card">
      <div class="auth-brand">
        <MeshrixJsMark class="brand-mark" />
        <div>
          <h1 class="auth-brand-name">Meshrix.js</h1>
          <p class="brand-subtitle">{{ tt('服务端控制台') }}</p>
        </div>
        <button
          class="tool-button tool-button-ghost tool-button-icon auth-language-button"
          type="button"
          :title="languageMode === 'en' ? msg.topbar.languageEnTitle : msg.topbar.languageZhTitle"
          :aria-label="languageMode === 'en' ? msg.topbar.languageEnLabel : msg.topbar.languageZhLabel"
          @click="toggleLanguage"
        >
          <span class="language-state-text" aria-hidden="true">{{ languageMode === 'en' ? 'EN' : '中' }}</span>
        </button>
        <div v-if="consoleBootstrapping" class="auth-connecting" :title="tt('正在连接服务端…')" :aria-label="tt('正在连接')">
          <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" class="auth-spinner-icon">
            <path d="M21 12a9 9 0 1 1-6.219-8.56"/>
          </svg>
        </div>
      </div>
      <div class="section-header">
        <div>
          <h3>{{ tt(consoleBootstrapping ? '正在连接…' : '控制台登录') }}</h3>
          <p v-if="consoleBootstrapping">{{ tt('正在确认登录状态，请稍候。') }}</p>
        </div>
      </div>

      <form class="form-grid auth-form" @submit.prevent="submitLoginAuth" :inert="consoleBootstrapping">
        <label>
          <span>{{ tt('用户名') }}</span>
          <input v-model="loginForm.username" type="text" autocomplete="username" :placeholder="tt('请输入用户名')" :disabled="consoleBootstrapping" />
        </label>
        <label>
          <span>{{ tt('密码') }}</span>
          <input v-model="loginForm.password" type="password" autocomplete="current-password" :placeholder="tt('请输入密码')" :disabled="consoleBootstrapping" />
        </label>
        <button class="primary-action" type="submit" :disabled="consoleBootstrapping || isBusy('auth:login')">
          {{ tt(isBusy("auth:login") ? "登录中" : "登录") }}
        </button>
      </form>
    </article>
  </section>
</template>
