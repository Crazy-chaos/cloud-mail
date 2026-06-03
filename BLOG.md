# CrazyChaos Blog Integration

This blog is split across the existing two deployments:

- Public frontend: `SubscribeTaFFyNya/blog/index.html`, deployed by GitHub Pages under `https://www.crazychaos.top/blog/`.
- Chinese alias: `https://www.crazychaos.top/博客/` redirects to `/blog/`.
- Direct post URL: `https://www.crazychaos.top/blog/?post={slug}`.
- RSS feed: `https://mail.crazychaos.top/api/blog/rss`.
- API and admin UI: `mail-worker` and `mail-vue`, served by `https://mail.crazychaos.top`.
- Metadata database: Cloudflare D1 table `blog_post`.
- Markdown body storage: R2/KV/S3 object key `blog/posts/{slug}.md`.

## Public API

```text
GET /api/blog/list?page=1&pageSize=20&q=keyword&category=note&tag=taffy
GET /api/blog/detail/:slug
GET /api/blog/rss
```

These routes are public and are consumed by the GitHub Pages blog frontend.

## Admin API

```text
GET    /api/blog/admin/list?q=keyword&status=published
GET    /api/blog/post/:slug
POST   /api/blog/post
POST   /api/blog/upload
DELETE /api/blog/post/:slug
```

These routes reuse the existing cookie/JWT login. The admin account always has access, and other roles can manage posts after receiving the `blog:manage` permission.

## Publishing Flow

1. Sign in to `mail.crazychaos.top` with the existing email/password account.
2. Open the sidebar management section and choose `博客`.
3. Create or edit a post.
4. Upload a cover image if needed. The image is stored under `blog/covers/`.
5. Use `draft` while editing, then switch to `published`.
6. Open `https://www.crazychaos.top/blog/` to verify the public view.

The backend creates the D1 table and the `blog:manage` permission record during `/api/init/{jwt_secret}`. The blog API also keeps a lazy self-healing check for older deployments.

## Deployment Notes

### D1

The Worker creates the blog table during the normal `/api/init/{jwt_secret}` flow. If an older deployment needs a manual repair after the main init has already created the base tables, run:

```bash
wrangler d1 execute cloudmail --file ./sql/blog.sql
```

Use the database name from the active Wrangler config if it differs from `cloudmail`.

### R2

Blog Markdown and cover images are written directly to the Worker R2 binding. Enable the R2 binding in the active Wrangler config:

```toml
[[r2_buckets]]
binding = "r2"
bucket_name = "your-r2-bucket"
```

The GitHub Actions production deployment requires the `R2_BUCKET_NAME` secret, checks the bucket through Wrangler, and creates it if it is missing. The blog API returns an error if the `r2` binding is missing. This keeps blog content in R2 instead of silently falling back to S3 or KV.

Do not commit Cloudflare account IDs, R2 API tokens, D1 IDs, access keys, or bucket secrets to the public repository. Keep them in Cloudflare bindings, Worker variables, or GitHub Secrets.

### GitHub Pages

Deploy these public files with the `www.crazychaos.top` site:

```text
SubscribeTaFFyNya/blog/index.html
SubscribeTaFFyNya/博客/index.html
SubscribeTaFFyNya/index.html
```

The main site sidebar links to `/blog/`; `/博客/` redirects to `/blog/`.
