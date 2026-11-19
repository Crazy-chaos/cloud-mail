<template>
  <emailScroll ref="scroll"
               :cancel-success="cancelStar"
               :star-success="addStar"
               :getEmailList="getEmailList"
               :emailDelete="emailDelete"
               :star-add="starAdd"
               :star-cancel="starCancel"
               :time-sort="params.timeSort"
               :email-read="emailRead"
               :show-unread="true"
               actionLeft="4px"
               @jump="jumpContent"
               @refresh-success="onRefreshSuccess"
  >
    <template #first>
      <Icon class="icon" @click="changeTimeSort" icon="material-symbols-light:timer-arrow-down-outline"
            v-if="params.timeSort === 0" width="28" height="28"/>
      <Icon class="icon" @click="changeTimeSort" icon="material-symbols-light:timer-arrow-up-outline" v-else
            width="28" height="28"/>
    </template>

  </emailScroll>
</template>

<script setup>
import {useAccountStore} from "@/store/account.js";
import {useEmailStore} from "@/store/email.js";
import {useSettingStore} from "@/store/setting.js";
import emailScroll from "@/components/email-scroll/index.vue"
import {emailList, emailDelete, emailLatest, emailRead} from "@/request/email.js";
import {starAdd, starCancel} from "@/request/star.js";
import {defineOptions, h, onBeforeUnmount, onMounted, reactive, ref, watch} from "vue";
import {sleep} from "@/utils/time-utils.js";
import router from "@/router/index.js";
import {Icon} from "@iconify/vue";
import { useRoute } from 'vue-router'
import {
  inboxWs,
  isAutoRefreshEnabled,
} from "@/websocket/client.js";

defineOptions({
  name: 'email'
})

const emailStore = useEmailStore();
const accountStore = useAccountStore();
const settingStore = useSettingStore();
const scroll = ref({})
const params = reactive({
  timeSort: 0,
})
const existIds = new Set();
let pullTimer = null

onMounted(() => {
  emailStore.emailScroll = scroll;
  // 收件箱实时：推送或重连后再拉 emailLatest，不按间隔轮询
  inboxWs.start({
    isEnabled: () => isAutoRefreshEnabled(settingStore.settings.autoRefresh),
    onMessage: onWsMessage,
    onReconnect: () => schedulePullLatest(),
  });
})

onBeforeUnmount(() => {
  if (pullTimer) {
    window.clearTimeout(pullTimer)
    pullTimer = null
  }
  inboxWs.stop()
})

watch(() => accountStore.currentAccountId, () => {
  scroll.value.refreshList();
})

function changeTimeSort() {
  params.timeSort = params.timeSort ? 0 : 1
  scroll.value.refreshList();
}

watch(() => settingStore.settings.autoRefresh, () => {
  inboxWs.sync()
})

function onRefreshSuccess() {
  inboxWs.retryNow()
}

function jumpContent(email) {
  emailStore.contentData.email = email
  emailStore.contentData.delType = 'logic'
  emailStore.contentData.showUnread = true
  emailStore.contentData.showStar = true
  emailStore.contentData.showReply = true
  router.push('/message')
}

// 推送到达：非「全部收取」时忽略其它账号的信。
function onWsMessage(event) {
  const allReceive = accountStore.currentAccount.allReceive
  if (!allReceive && event?.accountId != null && Number(event.accountId) !== Number(accountStore.currentAccountId)) {
    return
  }
  schedulePullLatest()
}

// 短时间多条推送合并成一次补拉。
function schedulePullLatest() {
  if (pullTimer) {
    window.clearTimeout(pullTimer)
  }
  pullTimer = window.setTimeout(() => {
    pullTimer = null
    void pullLatest()
  }, 150)
}

// 按当前列表最新 id 拉取之后的新邮件并插入。
async function pullLatest() {
  const searchParams = emailStore.searchParams
  if (searchParams.text || searchParams.startDate || searchParams.endDate) {
    return
  }

  if (scroll.value.firstLoad) {
    return
  }

  const latestId = scroll.value.latestEmail?.emailId
  const accountId = accountStore.currentAccountId
  const allReceive = scroll.value.latestEmail?.allReceive

  if (accountId !== scroll.value.latestEmail?.reqAccountId) {
    return
  }

  try {
    const list = await emailLatest(latestId, accountId, allReceive);

    if (accountId !== accountStore.currentAccountId || allReceive !== accountStore.currentAccount.allReceive) {
      return
    }

    if (list.length > 0) {
      emailStore.applyFullList(list)

      for (let email of list) {

        email.reqAccountId = accountId;
        email.allReceive = allReceive;

        if (!existIds.has(email.emailId)) {

          existIds.add(email.emailId)
          scroll.value.addItem(email)

          await sleep(50)
        }

      }

    }
  } catch (e) {
    if (e.code === 401 || e.code === 403) {
      settingStore.settings.autoRefresh = 1;
      inboxWs.sync();
    }
    console.error(e)
  }
}

function addStar(email) {
  emailStore.starScroll?.addItem(email)
}

function cancelStar(email) {
  emailStore.starScroll?.deleteEmail([email.emailId])
}

function getEmailList(emailId, size) {
  const accountId =  accountStore.currentAccountId;
  const allReceive = accountStore.currentAccount.allReceive;
  return emailList(accountId, allReceive, emailId, params.timeSort, size, 0).then(data => {
    data.latestEmail.reqAccountId = accountId;
    data.latestEmail.allReceive = allReceive;
    return data;
  })
}

</script>
<style>
.icon {
  cursor: pointer;
}
</style>
