import http from '@/axios/index.js';

export function blogAdminList(params) {
    return http.get('/blog/admin/list', { params: { ...params } });
}

export function blogPostDetail(slug) {
    return http.get(`/blog/post/${encodeURIComponent(slug)}`);
}

export function blogSavePost(form) {
    return http.post('/blog/post', form);
}

export function blogUploadCover(payload) {
    return http.post('/blog/upload', payload);
}

export function blogDeletePost(slug) {
    return http.delete(`/blog/post/${encodeURIComponent(slug)}`);
}
