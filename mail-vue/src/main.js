import {createApp} from 'vue';
import App from './App.vue';
import router from './router';
import './style.css';
import { init } from '@/init/init.js';
import { createPinia } from 'pinia';
import piniaPersistedState from 'pinia-plugin-persistedstate';
import 'element-plus/theme-chalk/dark/css-vars.css';
import 'nprogress/nprogress.css';
import perm from "@/perm/perm.js";
const pinia = createPinia().use(piniaPersistedState)
import i18n from "@/i18n/index.js";

const setAppViewportHeight = () => {
    const viewportHeight = Math.max(
        window.innerHeight || 0,
        window.visualViewport?.height || 0,
        document.documentElement.clientHeight || 0
    );
    document.documentElement.style.setProperty('--app-height', `${viewportHeight}px`);
}

const syncAppViewportHeight = () => {
    setAppViewportHeight();
    requestAnimationFrame(setAppViewportHeight);
    window.setTimeout(setAppViewportHeight, 250);
}

syncAppViewportHeight();
window.visualViewport?.addEventListener('resize', syncAppViewportHeight);
window.visualViewport?.addEventListener('scroll', syncAppViewportHeight);
window.addEventListener('resize', syncAppViewportHeight);
window.addEventListener('orientationchange', syncAppViewportHeight);
window.addEventListener('pageshow', syncAppViewportHeight);

const app = createApp(App).use(pinia)
await init()
app.use(router).use(i18n).directive('perm',perm)
app.config.devtools = true;

app.mount('#app');
