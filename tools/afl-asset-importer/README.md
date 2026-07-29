# AFL Career Asset Importer — Button Interface

## Easiest Windows method

1. Make sure Node.js LTS is installed.
2. Double-click `START AFL ASSET IMPORTER.bat`.
3. Your browser opens the importer screen.
4. Choose Players, Logos, or Both.
5. Choose all clubs or one club.
6. Click **Start Import**.

On the first run, the importer automatically installs its required components and Chromium browser. This may take several minutes.

Downloaded files are saved to:

- `assets/players/<CLUB>/<player-name>.webp`
- `assets/team-logos/<club-code>.webp`

The importer also creates `asset-map.js` and `asset-import-report.json`.

## Optional terminal method

Run `npm run ui` from this folder.
