<template>
  <div class="blog-admin">
    <div class="blog-toolbar">
      <div class="toolbar-title">
        <Icon icon="fluent:document-sparkle-24-regular" width="24" height="24" />
        <span>博客管理</span>
      </div>
      <div class="toolbar-actions">
        <el-input
            v-model="params.q"
            class="search-input"
            placeholder="搜索文章"
            clearable
            @keyup.enter="getList"
            @clear="getList"
        />
        <el-select v-model="params.status" class="status-select" placeholder="状态" clearable @change="getList">
          <el-option label="全部" value="" />
          <el-option label="已发布" value="published" />
          <el-option label="草稿" value="draft" />
        </el-select>
        <el-button type="primary" round @click="newPost">
          <Icon icon="ion:add-outline" width="18" height="18" />
          新文章
        </el-button>
        <el-button round @click="getList">
          <Icon icon="ion:reload" width="18" height="18" />
        </el-button>
      </div>
    </div>

    <div class="blog-grid">
      <section class="post-list glass-panel">
        <div v-if="loading" class="state">读取文章中...</div>
        <button
            v-for="post in posts"
            v-else
            :key="post.slug"
            type="button"
            class="post-item"
            :class="{ active: form.slug === post.slug }"
            @click="selectPost(post)"
        >
          <div class="post-main">
            <strong>{{ post.title }}</strong>
            <span>{{ post.summary || '没有摘要' }}</span>
          </div>
          <div class="post-meta">
            <el-tag :type="post.status === 'published' ? 'success' : 'info'" size="small">
              {{ post.status === 'published' ? '已发布' : '草稿' }}
            </el-tag>
            <el-tag size="small" effect="plain">{{ visibilityName(post.visibility) }}</el-tag>
            <span>{{ formatDate(post.updatedAt) }}</span>
          </div>
          <div v-if="post.author?.email" class="post-author">
            {{ post.author.nickname || post.author.email }} · {{ post.author.email }}
          </div>
        </button>
        <div v-if="!loading && posts.length === 0" class="state">还没有文章</div>
      </section>

      <section class="editor glass-panel">
        <el-form label-position="top">
          <div class="editor-head">
            <div>
              <h2>{{ form.slug ? '编辑文章' : '新文章' }}</h2>
              <p>正文会写入 R2/KV，列表信息会写入 D1。</p>
            </div>
            <div class="editor-actions">
              <el-button round @click="openBlog">打开博客</el-button>
              <el-button v-if="form.slug" type="danger" round plain @click="deletePost">删除</el-button>
              <el-button type="primary" round :loading="saving" @click="savePost">保存</el-button>
            </div>
          </div>

          <div class="form-row three">
            <el-form-item label="Slug">
              <el-input v-model="form.slug" placeholder="my-first-post" :disabled="Boolean(loadedSlug)" />
            </el-form-item>
            <el-form-item label="状态">
              <el-select v-model="form.status">
                <el-option label="草稿" value="draft" />
                <el-option label="发布" value="published" />
              </el-select>
            </el-form-item>
            <el-form-item label="可见度">
              <el-select v-model="form.visibility">
                <el-option label="所有人可见" value="public" />
                <el-option label="仅登录后可见" value="logged_in" />
                <el-option label="仅自己可见" value="private" />
              </el-select>
            </el-form-item>
          </div>

          <el-form-item label="标题">
            <el-input v-model="form.title" placeholder="文章标题" />
          </el-form-item>

          <el-form-item label="摘要">
            <el-input v-model="form.summary" type="textarea" :rows="3" placeholder="显示在博客列表里的简短描述" />
          </el-form-item>

          <div class="form-row two">
            <el-form-item label="分类">
              <el-input v-model="form.category" placeholder="更新记录" />
            </el-form-item>
            <el-form-item label="标签">
              <el-input v-model="tagText" placeholder="用英文逗号分隔，比如 taffy,cloudflare" />
            </el-form-item>
          </div>

          <el-form-item label="封面对象 Key">
            <div class="cover-row">
              <el-input v-model="form.coverKey" placeholder="blog/covers/cover.png，可先通过对象存储上传" />
              <el-button round :loading="uploadingCover" @click="chooseCover">
                <Icon icon="ion:cloud-upload-outline" width="18" height="18" />
                上传封面
              </el-button>
            </div>
            <img v-if="coverPreview" class="cover-preview" :src="coverPreview" alt="">
          </el-form-item>

          <el-form-item label="正文 *">
            <textarea id="blogEditorTextarea" placeholder="# 标题&#10;&#10;这里写正文..."></textarea>
          </el-form-item>
        </el-form>
      </section>
    </div>
  </div>
</template>

<script setup>
import {defineOptions, reactive, ref, onMounted, onUnmounted} from 'vue';
import {Icon} from '@iconify/vue';
import {ElMessage, ElMessageBox} from 'element-plus';
import {blogAdminList, blogDeletePost, blogPostDetail, blogSavePost, blogUploadCover} from '@/request/blog.js';
import {compressImage, fileToBase64} from '@/utils/file-utils.js';

defineOptions({
  name: 'blog-admin'
});

const EASYMDE_JS_URL = 'https://cdn.jsdelivr.net/npm/easymde/dist/easymde.min.js';
const EASYMDE_CSS_URL = 'https://cdn.jsdelivr.net/npm/easymde/dist/easymde.min.css';

let loadPromise = null;

function loadEasyMDE() {
  if (loadPromise) return loadPromise;
  loadPromise = new Promise((resolve, reject) => {
    if (window.EasyMDE) {
      resolve(window.EasyMDE);
      return;
    }
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = EASYMDE_CSS_URL;
    document.head.appendChild(link);
    
    const script = document.createElement('script');
    script.src = EASYMDE_JS_URL;
    script.onload = () => {
      if (window.EasyMDE) {
        resolve(window.EasyMDE);
      } else {
        reject(new Error('EasyMDE failed to load.'));
      }
    };
    script.onerror = () => reject(new Error('EasyMDE script load failed.'));
    document.body.appendChild(script);
  });
  return loadPromise;
}

let easyMDEInstance = null;

const params = reactive({
  page: 1,
  pageSize: 50,
  status: '',
  q: ''
});

const emptyForm = () => ({
  slug: '',
  title: '',
  summary: '',
  category: '',
  tags: [],
  coverKey: '',
  content: '',
  status: 'draft',
  visibility: 'public'
});

const posts = reactive([]);
const form = reactive(emptyForm());
const tagText = ref('');
const loading = ref(false);
const saving = ref(false);
const uploadingCover = ref(false);
const uploadingImage = ref(false);
const coverPreview = ref('');
const loadedSlug = ref('');

getList();

onMounted(async () => {
  try {
    const EasyMDE = await loadEasyMDE();
    initEasyMDE(EasyMDE);
  } catch (err) {
    ElMessage.error('加载 Markdown 编辑器失败: ' + err.message);
  }
});

onUnmounted(() => {
  if (easyMDEInstance) {
    easyMDEInstance.toTextArea();
    easyMDEInstance = null;
  }
});

function extractBvid(urlOrId) {
  if (!urlOrId) return null;
  const match = urlOrId.match(/(BV[a-zA-Z0-9]{10})/i);
  return match ? match[1] : null;
}

function makeBilibiliIframe(bvid) {
  return `<iframe style="width: 100%; aspect-ratio: 16/9;" src="https://player.bilibili.com/player.html?bvid=${bvid}" scrolling="no" border="0" frameborder="no" framespacing="0" allowfullscreen="true"></iframe>`;
}

async function insertBilibiliVideo(editor) {
  try {
    const res = await ElMessageBox.prompt('请输入 B 站视频链接或 BV 号：\n例如：https://www.bilibili.com/video/BV1GPGR6GEa6', '插入 B 站视频', {
      confirmButtonText: '确定',
      cancelButtonText: '取消',
      inputPlaceholder: 'https://www.bilibili.com/video/...'
    });
    if (!res || !res.value) return;
    const bvid = extractBvid(res.value);
    if (!bvid) {
      ElMessage.warning('未识别到有效的 B 站 BV 号，请检查输入的链接！');
      return;
    }
    const iframe = makeBilibiliIframe(bvid);
    const cm = editor.codemirror;
    const doc = cm.getDoc();
    const cursor = doc.getCursor();
    doc.replaceRange(iframe, cursor);
  } catch (err) {
    // cancelled
  }
}

function initEasyMDE(EasyMDE) {
  if (easyMDEInstance) {
    easyMDEInstance.value(form.content || '');
    return;
  }
  
  easyMDEInstance = new EasyMDE({
    element: document.getElementById('blogEditorTextarea'),
    initialValue: form.content || '',
    autoDownloadFontAwesome: true,
    spellChecker: false,
    autosave: {
      enabled: true,
      uniqueId: "TaffyMailBlogEditorAutoSave",
      delay: 10000,
    },
    renderingConfig: {
      codeSyntaxHighlighting: true
    },
    toolbar: [
      { name: "bold", action: EasyMDE.toggleBold, className: "fa fa-bold", title: "加粗 (Ctrl-B)" },
      { name: "italic", action: EasyMDE.toggleItalic, className: "fa fa-italic", title: "斜体 (Ctrl-I)" },
      { name: "heading", action: EasyMDE.toggleHeadingSmaller, className: "fa fa-header", title: "标题 (Ctrl-H)" },
      "|",
      { name: "quote", action: EasyMDE.toggleBlockquote, className: "fa fa-quote-left", title: "引用 (Ctrl-')" },
      { name: "unordered-list", action: EasyMDE.toggleUnorderedList, className: "fa fa-list-ul", title: "无序列表 (Ctrl-L)" },
      { name: "ordered-list", action: EasyMDE.toggleOrderedList, className: "fa fa-list-ol", title: "有序列表 (Ctrl-Alt-L)" },
      "|",
      { name: "link", action: EasyMDE.drawLink, className: "fa fa-link", title: "插入链接 (Ctrl-K)" },
      { 
        name: "image", 
        action: (editor) => {
          chooseMarkdownImage(editor);
        }, 
        className: "fa fa-picture-o", 
        title: "插入图片 (Ctrl-Alt-I)" 
      },
      { name: "table", action: EasyMDE.drawTable, className: "fa fa-table", title: "插入表格" },
      { name: "bilibili", action: insertBilibiliVideo, className: "fa fa-play-circle", title: "插入B站视频" },
      "|",
      { name: "preview", action: EasyMDE.togglePreview, className: "fa fa-eye no-disable", title: "预览 (Ctrl-P)" },
      { name: "side-by-side", action: EasyMDE.toggleSideBySide, className: "fa fa-columns no-disable no-mobile", title: "分栏预览 (F9)" },
      { name: "fullscreen", action: EasyMDE.toggleFullScreen, className: "fa fa-arrows-alt no-disable no-mobile", title: "全屏 (F11)" },
      "|",
      { name: "guide", action: () => window.open("https://www.markdownguide.org/basic-syntax/", "_blank"), className: "fa fa-question-circle", title: "Markdown 使用指南" }
    ]
  });

  easyMDEInstance.codemirror.on('change', () => {
    form.content = easyMDEInstance.value();
  });

  easyMDEInstance.codemirror.on('paste', (cm, e) => {
    const text = e.clipboardData?.getData('text/plain');
    if (text) {
      const bvid = extractBvid(text);
      if (bvid && (text.includes('bilibili.com') || text.startsWith('BV'))) {
        e.preventDefault();
        const iframe = makeBilibiliIframe(bvid);
        const doc = cm.getDoc();
        const cursor = doc.getCursor();
        doc.replaceRange(iframe, cursor);
      }
    }
  });
}

function resetForm(data = emptyForm()) {
  Object.assign(form, emptyForm(), data);
  tagText.value = (form.tags || []).join(', ');
  loadedSlug.value = data.slug || '';
  coverPreview.value = data.coverUrl || '';
  
  if (easyMDEInstance) {
    easyMDEInstance.value(form.content || '');
  }
}

function getList() {
  loading.value = true;
  blogAdminList(params)
      .then(data => {
        posts.length = 0;
        posts.push(...(data.list || []));
      })
      .finally(() => {
        loading.value = false;
      });
}

function newPost() {
  resetForm();
}

function selectPost(post) {
  blogPostDetail(post.slug).then(data => {
    resetForm({
      slug: data.slug,
      title: data.title,
      summary: data.summary,
      category: data.category,
      tags: data.tags || [],
      coverKey: data.coverKey || '',
      content: data.content || '',
      status: data.status || 'draft',
      visibility: data.visibility || 'public'
    });
    coverPreview.value = data.coverUrl || '';
  });
}

function chooseMarkdownImage(editor) {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'image/png,image/jpeg,image/webp,image/gif,image/avif';
  input.onchange = async () => {
    const file = input.files?.[0];
    if (!file) return;
    await uploadMarkdownImage(file, editor);
  };
  input.click();
}

async function uploadMarkdownImage(file, editor) {
  if (!file.type.startsWith('image/')) {
    ElMessage.warning('请选择图片文件');
    return;
  }

  uploadingImage.value = true;
  try {
    const image = await compressImage(file, {
      convertSize: 900 * 1024,
      quality: 0.9
    });
    const content = await fileToBase64(image, true);
    const data = await blogUploadCover({
      filename: image.name || file.name,
      contentType: image.type || file.type,
      content
    });
    
    if (editor) {
      const cm = editor.codemirror;
      const doc = cm.getDoc();
      const cursor = doc.getCursor();
      const text = `![${file.name.replace(/\.[^.]+$/, '')}](${data.url})`;
      doc.replaceRange(text, cursor);
    }
    ElMessage.success('图片已插入正文');
  } finally {
    uploadingImage.value = false;
  }
}

function chooseCover() {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'image/png,image/jpeg,image/webp,image/gif,image/avif';
  input.onchange = async () => {
    const file = input.files?.[0];
    if (!file) return;
    await uploadCover(file);
  };
  input.click();
}

async function uploadCover(file) {
  if (!file.type.startsWith('image/')) {
    ElMessage.warning('请选择图片文件');
    return;
  }

  uploadingCover.value = true;
  try {
    const image = await compressImage(file, {
      convertSize: 500 * 1024,
      quality: 0.86
    });
    const content = await fileToBase64(image, true);
    const data = await blogUploadCover({
      filename: image.name || file.name,
      contentType: image.type || file.type,
      content
    });
    form.coverKey = data.key;
    coverPreview.value = data.url;
    ElMessage.success('封面已上传');
  } finally {
    uploadingCover.value = false;
  }
}

function savePost() {
  saving.value = true;
  blogSavePost({
    ...form,
    tags: tagText.value.split(',').map(tag => tag.trim()).filter(Boolean)
  })
      .then(data => {
        ElMessage.success('已保存');
        if (easyMDEInstance) {
          easyMDEInstance.clearAutosavedValue();
        }
        resetForm({
          slug: data.slug,
          title: data.title,
          summary: data.summary,
          category: data.category,
          tags: data.tags || [],
          coverKey: data.coverKey || '',
          coverUrl: data.coverUrl || '',
          content: data.content || '',
          status: data.status || form.status,
          visibility: data.visibility || form.visibility
        });
        getList();
      })
      .finally(() => {
        saving.value = false;
      });
}

function deletePost() {
  if (!form.slug) return;
  ElMessageBox.confirm(`删除文章「${form.title || form.slug}」？`, '删除博客', {
    type: 'warning',
    confirmButtonText: '删除',
    cancelButtonText: '取消'
  }).then(() => {
    return blogDeletePost(form.slug);
  }).then(() => {
    ElMessage.success('已删除');
    resetForm();
    getList();
  });
}

function openBlog() {
  window.open('https://www.crazychaos.top/blog/', '_blank', 'noopener');
}

function formatDate(value) {
  if (!value) return '-';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleDateString('zh-CN', {month: '2-digit', day: '2-digit'});
}

function visibilityName(value) {
  const map = {
    public: '所有人',
    logged_in: '登录可见',
    private: '仅自己'
  };
  return map[value] || map.public;
}
</script>

<style lang="scss" scoped>
.blog-admin {
  height: 100%;
  padding: 18px;
  overflow: hidden;
}

.blog-toolbar,
.glass-panel {
  border: 1px solid var(--glass-border);
  background: var(--glass-bg);
  box-shadow: var(--glass-shadow);
  backdrop-filter: blur(12px);
  -webkit-backdrop-filter: blur(12px);
}

.blog-toolbar {
  height: 64px;
  border-radius: 18px;
  padding: 0 16px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.toolbar-title,
.toolbar-actions,
.editor-actions {
  display: flex;
  align-items: center;
  gap: 10px;
}

.toolbar-title {
  color: #fff;
  font-size: 18px;
  font-weight: 800;
}

.status-select {
  width: 130px;
}

.search-input {
  width: 210px;
}

.blog-grid {
  height: calc(100% - 82px);
  margin-top: 18px;
  display: grid;
  grid-template-columns: 320px minmax(0, 1fr);
  gap: 18px;
}

.glass-panel {
  border-radius: 18px;
  overflow: hidden;
}

.post-list {
  padding: 12px;
  overflow-y: auto;
}

.post-item {
  width: 100%;
  margin-bottom: 10px;
  padding: 12px;
  border-radius: 14px;
  border: 1px solid rgba(255, 255, 255, 0.3);
  background: rgba(255, 255, 255, 0.16);
  color: var(--el-text-color-primary);
  cursor: pointer;
  text-align: left;
  transition: all 0.2s ease;
}

.post-item:hover,
.post-item.active {
  transform: translateY(-2px);
  background: rgba(255, 121, 198, 0.26);
  box-shadow: 0 8px 20px rgba(255, 121, 198, 0.22);
}

.post-main {
  display: grid;
  gap: 5px;

  strong,
  span {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  span {
    opacity: 0.72;
    font-size: 13px;
  }
}

.post-meta {
  margin-top: 10px;
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 8px;
  color: var(--el-text-color-secondary);
  font-size: 12px;
}

.post-author {
  margin-top: 6px;
  color: var(--el-text-color-secondary);
  font-size: 12px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.editor {
  padding: 18px;
  overflow-y: auto;
}

.editor-head {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 16px;
  margin-bottom: 18px;

  h2 {
    margin: 0;
    color: #ff79c6;
  }

  p {
    margin: 6px 0 0;
    color: var(--el-text-color-secondary);
  }
}

.form-row {
  display: grid;
  gap: 14px;

  &.two {
    grid-template-columns: 1fr 1fr;
  }

  &.three {
    grid-template-columns: 1fr 150px 190px;
  }
}

.markdown-toolbar {
  width: 100%;
  margin-bottom: 10px;
  display: flex;
  align-items: center;
  gap: 10px;
  color: var(--el-text-color-secondary);
  font-size: 12px;
  flex-wrap: wrap;
}

.content-input {
  :deep(textarea) {
    font-family: Consolas, "SFMono-Regular", monospace;
    line-height: 1.7;
  }
}

.cover-row {
  width: 100%;
  display: flex;
  gap: 10px;
  align-items: center;

  .el-button {
    flex-shrink: 0;
  }
}

.cover-preview {
  width: 160px;
  height: 96px;
  margin-top: 10px;
  border-radius: 12px;
  object-fit: cover;
  border: 1px solid var(--glass-border);
  box-shadow: 0 8px 22px rgba(255, 121, 198, 0.18);
}

.state {
  height: 180px;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--el-text-color-secondary);
}

@media (max-width: 1025px) {
  .blog-admin {
    padding: 12px;
  }

  .blog-toolbar {
    height: auto;
    min-height: 58px;
    align-items: flex-start;
    flex-direction: column;
    padding: 12px;
  }

  .toolbar-actions {
    width: 100%;
    flex-wrap: wrap;
  }

  .search-input,
  .status-select {
    width: 100%;
  }

  .blog-grid {
    height: calc(100% - 128px);
    grid-template-columns: 1fr;
    overflow-y: auto;
  }

  .post-list {
    max-height: 260px;
  }

  .editor {
    overflow: visible;
  }

  .editor-head,
  .form-row.two,
  .form-row.three {
    grid-template-columns: 1fr;
    flex-direction: column;
  }

  .cover-row {
    align-items: stretch;
    flex-direction: column;
  }
}

:deep(.EasyMDEContainer) {
  border: 1px solid var(--glass-border) !important;
  border-radius: 12px;
  overflow: hidden;
  background: rgba(255, 255, 255, 0.05) !important;
  
  .editor-toolbar {
    border: none !important;
    border-bottom: 1px solid var(--glass-border) !important;
    background: rgba(255, 255, 255, 0.08) !important;
    opacity: 1 !important;
    padding: 6px 12px;
    
    button {
      color: #fff !important;
      border-radius: 6px;
      transition: all 0.2s ease;
      width: 30px;
      height: 30px;
      margin: 0 2px;
      
      &:hover,
      &.active {
        background: rgba(255, 121, 198, 0.26) !important;
        color: #ff79c6 !important;
      }
    }
    
    i.separator {
      border-right-color: var(--glass-border) !important;
    }
  }
  
  .CodeMirror {
    border: none !important;
    background: transparent !important;
    color: #fff !important;
    font-family: Consolas, "SFMono-Regular", monospace !important;
    font-size: 14px !important;
    line-height: 1.6 !important;
    min-height: 350px;
  }
  
  .CodeMirror-cursor {
    border-left-color: #fff !important;
  }
  
  .editor-preview-side,
  .editor-preview {
    background: #21142e !important;
    color: #fff !important;
    border: none !important;
    backdrop-filter: blur(20px);
    -webkit-backdrop-filter: blur(20px);
    
    pre {
      background: rgba(255, 255, 255, 0.05) !important;
      color: inherit !important;
    }
  }
}
</style>
