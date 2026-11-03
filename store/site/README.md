# Kopernikadr site (GitHub Pages)

Static site: landing page and the privacy policy in English, Polish and Russian. Plain HTML, inline CSS, no JS, no external resources.

## Before publishing
Replace `CONTACT_EMAIL` with the real address in all four HTML files:

    grep -rl CONTACT_EMAIL store/site | xargs sed -i '' 's/CONTACT_EMAIL/you@example.com/g'

## Publish
1. Create a **public** repo `tslava/kopernikadr-site` on GitHub (empty).
2. Push the contents of this folder as the repo root (the repo root must contain `index.html`):

       cd store/site && git init -b main && git add . && git commit -m "site" \
         && git remote add origin git@github.com:tslava/kopernikadr-site.git && git push -u origin main

3. Repo Settings > Pages > Build and deployment: Source "Deploy from a branch", branch `main`, folder `/ (root)`.

## URLs
- Landing: https://tslava.github.io/kopernikadr-site/
- Privacy (English): https://tslava.github.io/kopernikadr-site/privacy/
- Privacy (Polish): https://tslava.github.io/kopernikadr-site/pl/privacy/
- Privacy (Russian): https://tslava.github.io/kopernikadr-site/ru/privacy/

Use the English or Polish URL in Play Console (same URL for both apps).
