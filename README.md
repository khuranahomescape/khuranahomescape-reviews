# khuranahomescape

Independent buyer-reviews site for Khurana Homescape (Chetan Khurana, Arun Khurana). Punjabi Bagh, Meera Bagh, Paschim Vihar, West Delhi.

- `public/` static site. `src/worker.js` Cloudflare Worker: serves the site, accepts anonymous submissions (`/api/submit`), lists approved reviews (`/api/reviews`), and handles moderation links (`/m/...`).
- Storage: Cloudflare KV (`REVIEWS`). All storage calls go through the `store` object in `worker.js`, so a database can replace KV later.
- Moderation: each submission emails the moderator inbox with signed approve/reject links. Nothing is published until approved.
- `apps-script/Code.gs` is the tiny mail relay that runs in the moderator Google account.
- No reviews are seeded. All reviews are personal opinions of their authors.

Secrets (Worker): ADMIN_SECRET, MAIL_SECRET, MAIL_WEBHOOK. Deploy: `npx wrangler deploy`.
