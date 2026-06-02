<template>
  <el-container class="layout">
    <el-aside
        class="aside"
        :class="uiStore.asideShow ? 'aside-show' : 'el-aside-hide'">
      <Aside />
    </el-aside>
    <div
        :class="(uiStore.asideShow && isMobile)? 'overlay-show':'overlay-hide'"
        @click="uiStore.asideShow = false"
    ></div>
    <el-container class="main-container">
      <el-main>
        <el-header>
            <Header />
        </el-header>
        <Main />
      </el-main>
    </el-container>
  </el-container>
  <writer ref="writerRef" />
</template>

<script setup>
import Aside from '@/layout/aside/index.vue'
import Header from '@/layout/header/index.vue'
import Main from '@/layout/main/index.vue'
import { ref, onMounted, onBeforeUnmount } from 'vue'
import {useUiStore} from "@/store/ui.js";
import writer from '@/layout/write/index.vue'

const uiStore = useUiStore();
const writerRef = ref({})
const isMobile = ref(window.innerWidth < 1025)
const handleResize = () => {
  isMobile.value = window.innerWidth < 1025
  uiStore.asideShow = window.innerWidth > 1024;
}

onMounted(() => {
  uiStore.writerRef = writerRef

  window.addEventListener('resize', handleResize)
  handleResize()
})

onBeforeUnmount(() => {
  window.removeEventListener('resize', handleResize)
})
</script>

<style lang="scss" scoped>
.el-aside-hide {
  position: fixed;
  left: 0;
  height: calc(100% - 40px);
  margin: 20px 0 20px 20px;
  z-index: 100;
  transform: translateX(-150%);
  transition: all 200ms cubic-bezier(0.68, -0.55, 0.265, 1.55);
}

.aside-show {
  transform: translateX(0);
  transition: all 200ms cubic-bezier(0.25, 0.8, 0.25, 1);
  z-index: 101;
  margin: 20px 0 20px 20px;
  height: calc(100% - 40px);
  border-radius: 20px;
  background: var(--glass-bg);
  backdrop-filter: blur(12px);
  -webkit-backdrop-filter: blur(12px);
  border: 1px solid var(--glass-border);
  box-shadow: var(--glass-shadow);
  @media (max-width: 1025px) {
    position: fixed;
    top: 0;
    left: 0;
    margin: 0;
    border-radius: 0;
    height: 100%;
    z-index: 101;
    background: var(--el-bg-color);
  }
}

.el-aside {
  width: auto;
  transition: all 200ms ease;
}

.layout {
  height: 100%;
  position: fixed;
  width: 100%;
  top: 0;
  left: 0;
  overflow: hidden;
}

.main-container {
  height: calc(100% - 40px);
  margin: 20px;
  border-radius: 20px;
  background: var(--glass-bg);
  backdrop-filter: blur(12px);
  -webkit-backdrop-filter: blur(12px);
  box-shadow: var(--glass-shadow);
  border: 1px solid var(--glass-border);
  overflow-y: auto;
  -webkit-overflow-scrolling: touch;
}

.el-main {
  padding: 0;
  border-radius: 20px;
}

.el-header {
  background: transparent;
  border-bottom: solid 1px var(--glass-border);
  border-top-left-radius: 20px;
  border-top-right-radius: 20px;
  padding: 0 0 0 0;
}

.overlay-show {
  position: fixed;
  top: 0;
  left: 0;
  width: 100vw;
  height: 100vh;
  background: rgba(0, 0, 0, 0.4);
  z-index: 99;
  transition: all 0.3s;
}

.overlay-hide {
  display: flex;
  pointer-events: none;
  opacity: 0;
}

@media (max-width: 1025px) {
  .layout {
    height: 100dvh;
    padding: 0;
    background: transparent;
  }

  .main-container {
    height: calc(100dvh - 32px - env(safe-area-inset-top) - env(safe-area-inset-bottom));
    margin: calc(22px + env(safe-area-inset-top)) 12px calc(10px + env(safe-area-inset-bottom));
    border-radius: 18px;
  }

  .el-main {
    height: 100%;
    overflow: hidden;
  }

  .el-header {
    border-top-left-radius: 18px;
    border-top-right-radius: 18px;
  }

  .aside-show,
  .el-aside-hide {
    top: env(safe-area-inset-top);
    height: calc(100dvh - env(safe-area-inset-top) - env(safe-area-inset-bottom));
  }

  .overlay-show {
    height: 100dvh;
  }
}
</style>
