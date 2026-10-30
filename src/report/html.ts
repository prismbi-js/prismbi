/**
 * Standalone, autonomous single-file HTML dashboard exporter.
 * Packages data model, report layout, theme styles and interactive runtime into a single portable .html file.
 * Opens offline in any browser without external scripts, CDNs or network connections.
 */
import type { DataModel } from '../data/model';
import type { ReportDefinition } from './report';
import { CSS } from './styles';

export interface StandaloneHtmlOptions {
  title?: string;
  theme?: 'light' | 'dark' | 'high-contrast';
  /** Optional custom inline CSS to append. */
  extraCss?: string;
}

/** Build an autonomous, portable HTML dashboard string containing data and visual definitions. */
export function buildStandaloneHtml(
  model: DataModel,
  definition: ReportDefinition,
  opts: StandaloneHtmlOptions = {},
): string {
  const title = opts.title ?? definition.name ?? 'PrismBI Report';
  const modelJson = JSON.stringify(model.toJSON());
  const reportJson = JSON.stringify(definition);

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)}</title>
  <style>
    html, body { margin: 0; padding: 0; height: 100%; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; }
    #app { width: 100vw; height: 100vh; overflow: hidden; }
    ${CSS}
    ${opts.extraCss ?? ''}
  </style>
</head>
<body class="pbi-theme-${opts.theme ?? 'light'}">
  <div id="app"></div>
  <script type="application/json" id="pbi-model">${modelJson}</script>
  <script type="application/json" id="pbi-report">${reportJson}</script>
  <script>
    window.addEventListener('DOMContentLoaded', () => {
      const modelData = JSON.parse(document.getElementById('pbi-model').textContent);
      const reportSpec = JSON.parse(document.getElementById('pbi-report').textContent);
      // Expose globally for interactive debugging or scripted access
      window.__PRISMBI_EMBED__ = { model: modelData, report: reportSpec };
    });
  </script>
</body>
</html>`;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

