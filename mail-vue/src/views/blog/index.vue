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

          <el-form-item label="正文 Markdown">
            <div class="markdown-toolbar">
              <el-button round :loading="uploadingImage" @click="chooseMarkdownImage">
                <Icon icon="ion:image-outline" width="18" height="18" />
                插入图片
              </el-button>
              <span>支持 Markdown 图片语法：![描述](图片地址)</span>
            </div>
            <el-input
                ref="contentInputRef"
                v-model="form.content"
                class="content-input"
                type="textarea"
                :rows="18"
                resize="none"
                placeholder="# 标题&#10;&#10;这里写正文..."
            />
          </el-form-item>
        </el-form>
      </section>
    </div>
  </div>
</template>

<script setup>
import {defineOptions, reactive, ref} from 'vue';
import {Icon} from '@iconify/vue';
import {ElMessage, ElMessageBox} from 'element-plus';
import {blogAdminList, blogDeletePost, blogPostDetail, blogSavePost, blogUploadCover} from '@/request/blog.js';
import {compressImage, fileToBase64} from '@/utils/file-utils.js';

defineOptions({
  name: 'blog-admin'
});

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
const contentInputRef = ref(null);

getList();

function resetForm(data = emptyForm()) {
  Object.assign(form, emptyForm(), data);
  tagText.value = (form.tags || []).join(', ');
  loadedSlug.value = data.slug || '';
  coverPreview.value = data.coverUrl || '';
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

function chooseMarkdownImage() {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'image/png,image/jpeg,image/webp,image/gif,image/avif';
  input.onchange = async () => {
    const file = input.files?.[0];
    if (!file) return;
    await uploadMarkdownImage(file);
  };
  input.click();
}

async function uploadMarkdownImage(file) {
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
    insertAtCursor(`![${file.name.replace(/\.[^.]+$/, '')}](${data.url})`);
    ElMessage.success('图片已插入正文');
  } finally {
    uploadingImage.value = false;
  }
}

function insertAtCursor(text) {
  const textarea = contentInputRef.value?.textarea || contentInputRef.value?.$el?.querySelector('textarea');
  if (!textarea) {
    form.content = `${form.content || ''}\n\n${text}\n`;
    return;
  }

  const start = textarea.selectionStart ?? form.content.length;
  const end = textarea.selectionEnd ?? form.content.length;
  const before = form.content.slice(0, start);
  const after = form.content.slice(end);
  const prefix = before && !before.endsWith('\n') ? '\n\n' : '';
  const suffix = after && !after.startsWith('\n') ? '\n\n' : '\n';
  form.content = `${before}${prefix}${text}${suffix}${after}`;
  requestAnimationFrame(() => {
    textarea.focus();
    const cursor = start + prefix.length + text.length + suffix.length;
    textarea.setSelectionRange(cursor, cursor);
  });
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
</style>
