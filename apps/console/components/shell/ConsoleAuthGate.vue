<script setup lang="ts">
import { useServerConsoleShellContext } from "@meshrix/ui-console/server-console-shell-context";

const {
  consoleBootstrapping,
  isBusy,
  languageMode,
  loginForm,
  msg,
  submitLoginAuth,
  toggleLanguage,
  tt,
} = useServerConsoleShellContext();
</script>

<template>
  <section class="auth-gate">
    <article class="surface-card auth-card">
      <div class="auth-brand">
        <svg class="brand-mark" aria-hidden="true" viewBox="-150 -150 300 300" xmlns="http://www.w3.org/2000/svg">
          <defs>
            <linearGradient id="ag-gold" x1="0" y1="0" x2="1" y2="1">
              <stop class="brand-gold-0" offset="0%"/><stop class="brand-gold-1" offset="50%"/><stop class="brand-gold-2" offset="100%"/>
            </linearGradient>
            <linearGradient id="ag-silver" x1="0" y1="1" x2="1" y2="0">
              <stop class="brand-silver-0" offset="0%"/><stop class="brand-silver-1" offset="100%"/>
            </linearGradient>
          </defs>
          <polygon fill="none" points="115.5,47.8 47.8,115.5 -47.8,115.5 -115.5,47.8 -115.5,-47.8 -47.8,-115.5 47.8,-115.5 115.5,-47.8" stroke="url(#ag-gold)" stroke-width="6" opacity="0.75"/>
          <circle class="brand-ring-primary" r="113" fill="none" stroke-width="4" opacity="0.5"/>
          <circle cx="-16" cy="16" r="89" fill="none" stroke="url(#ag-silver)" stroke-width="3.5" opacity="0.45"/>
          <circle class="brand-ring-secondary" cx="13" cy="-10" r="63" fill="none" stroke-width="3.5" opacity="0.5"/>
          <circle r="36" fill="none" stroke="url(#ag-gold)" stroke-width="4" opacity="0.6"/>
          <circle class="brand-dot" r="6" opacity="0.6"/>
        </svg>
        <div>
          <h1 class="auth-brand-name">Meshrix</h1>
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

<style scoped>
.brand-mark .brand-gold-0 { stop-color: var(--brand); }
.brand-mark .brand-gold-1 { stop-color: var(--brand-strong); }
.brand-mark .brand-gold-2 { stop-color: var(--brand-muted); }
.brand-mark .brand-silver-0 { stop-color: var(--text-muted); }
.brand-mark .brand-silver-1 { stop-color: var(--text-secondary); }
.brand-mark .brand-ring-primary { stroke: var(--text-primary); }
.brand-mark .brand-ring-secondary { stroke: var(--text-secondary); }
.brand-mark .brand-dot { fill: var(--brand); }
</style>
