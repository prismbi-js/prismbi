import type { Theme } from '../theme/theme';
import { CSS, themeVars } from './styles';

/**
 * Serialise a rendered element into a standalone SVG (HTML embedded via foreignObject,
 * PrismBI styles and theme variables inlined) so it can be saved or rasterised.
 */
export function elementToSvg(el: HTMLElement, theme: Theme, width: number, height: number, extraClass = ''): string {
  const clone = el.cloneNode(true) as HTMLElement;
  clone.querySelectorAll('.pbi-icons, .pbi-ei').forEach((n) => n.remove());
  // canvases (dense scatter, WebGL) don't clone their pixels: embed them as images
  const sources = [...el.querySelectorAll('canvas')];
  clone.querySelectorAll('canvas').forEach((c, i) => {
    try {
      const img = document.createElement('img');
      img.src = sources[i].toDataURL('image/png');
      img.setAttribute('style', c.getAttribute('style') ?? '');
      img.className = c.className;
      c.replaceWith(img);
    } catch {
      /* tainted or unsupported canvas: leave it out */
    }
  });
  clone.classList.remove('is-focus', 'is-active');
  clone.style.width = `${width}px`;
  clone.style.height = `${height}px`;
  const vars = Object.entries(themeVars(theme))
    .map(([k, v]) => `${k}:${v}`)
    .join(';');
  const body = new XMLSerializer().serializeToString(clone);
  const css = CSS.replace(/&/g, '&amp;').replace(/</g, '&lt;');
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">` +
    `<foreignObject x="0" y="0" width="${width}" height="${height}">` +
    `<div xmlns="http://www.w3.org/1999/xhtml" class="pbi-report pbi-export ${extraClass}" data-mode="${theme.mode}" style="${vars};height:${height}px;background:transparent">` +
    `<style>${css}</style>${body}</div></foreignObject></svg>`
  );
}

/** Rasterise an SVG string onto a canvas (2× by default). */
export async function svgToCanvas(svg: string, background: string, scale = 2): Promise<HTMLCanvasElement> {
  const img = new Image();
  await new Promise<void>((resolve, reject) => {
    img.onload = () => resolve();
    img.onerror = () => reject(new Error('Could not rasterise the snapshot'));
    img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  });
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(img.width * scale));
  canvas.height = Math.max(1, Math.round(img.height * scale));
  const c2d = canvas.getContext('2d')!;
  c2d.fillStyle = background;
  c2d.fillRect(0, 0, canvas.width, canvas.height);
  c2d.scale(scale, scale);
  c2d.drawImage(img, 0, 0);
  return canvas;
}

export function download(blob: Blob, filename: string): void {
  const href = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = href;
  a.download = filename;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(href), 1000);
}
