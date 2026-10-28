/**
 * Minimal, dependency-free PowerPoint (.pptx) presentation writer.
 * Packages high-resolution page or visual snapshots as full-bleed slide images in OpenXML format.
 * Compatible with PowerPoint, Google Slides, Keynote, and LibreOffice Impress.
 */
import { zip } from './xlsx';

export interface PptxSlide {
  image: Uint8Array;
  /** Image format: `'jpeg'` (default) or `'png'`. */
  format?: 'jpeg' | 'png';
  /** Slide width in CSS pixels (default 1280). */
  width?: number;
  /** Slide height in CSS pixels (default 720). */
  height?: number;
  /** Optional slide title. */
  title?: string;
}

export const PPTX_MIME = 'application/vnd.openxmlformats-officedocument.presentationml.presentation';

const XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
const enc = new TextEncoder();
const utf8 = (s: string) => enc.encode(s);
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** 1 CSS pixel = 9525 EMUs (English Metric Units: 914400 EMUs per inch / 96 dpi). */
const EMU_PER_PX = 9525;

/** Build a standalone .pptx presentation file from slide snapshots. */
export function buildPptx(slides: PptxSlide[], _title = 'Report'): Uint8Array {
  if (!slides.length) throw new Error('buildPptx needs at least one slide');

  const slideW = slides[0].width ?? 1280;
  const slideH = slides[0].height ?? 720;
  const slideW_EMU = Math.round(slideW * EMU_PER_PX);
  const slideH_EMU = Math.round(slideH * EMU_PER_PX);

  const files: [string, Uint8Array][] = [];

  // 1. [Content_Types].xml
  const contentTypesXml = `${XML}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Default Extension="jpeg" ContentType="image/jpeg"/>
  <Default Extension="jpg" ContentType="image/jpeg"/>
  <Default Extension="png" ContentType="image/png"/>
  <Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>
${slides.map((_, i) => `  <Override PartName="/ppt/slides/slide${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>`).join('\n')}
</Types>`;
  files.push(['[Content_Types].xml', utf8(contentTypesXml)]);

  // 2. _rels/.rels
  const rootRelsXml = `${XML}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/>
</Relationships>`;
  files.push(['_rels/.rels', utf8(rootRelsXml)]);

  // 3. ppt/presentation.xml
  const presentationXml = `${XML}<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">
  <p:sldIdLst>
${slides.map((_, i) => `    <p:sldId id="${256 + i}" r:id="rId${i + 1}"/>`).join('\n')}
  </p:sldIdLst>
  <p:sldSz cx="${slideW_EMU}" cy="${slideH_EMU}"/>
</p:presentation>`;
  files.push(['ppt/presentation.xml', utf8(presentationXml)]);

  // 4. ppt/_rels/presentation.xml.rels
  const presentationRelsXml = `${XML}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
${slides.map((_, i) => `  <Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide${i + 1}.xml"/>`).join('\n')}
</Relationships>`;
  files.push(['ppt/_rels/presentation.xml.rels', utf8(presentationRelsXml)]);

  // 5. Slides, Slide Rels, and Media images
  slides.forEach((s, i) => {
    const idx = i + 1;
    const ext = s.format === 'png' ? 'png' : 'jpeg';
    const wEmu = Math.round((s.width ?? slideW) * EMU_PER_PX);
    const hEmu = Math.round((s.height ?? slideH) * EMU_PER_PX);

    const slideXml = `${XML}<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">
  <p:cSld>
    <p:spTree>
      <p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>
      <p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>
      <p:pic>
        <p:nvPicPr>
          <p:cNvPr id="2" name="${esc(s.title ?? `Slide ${idx}`)}"/>
          <p:cNvPicPr><a:picLocks noChangeAspect="1"/></p:cNvPicPr>
          <p:nvPr/>
        </p:nvPicPr>
        <p:blipFill>
          <a:blip r:embed="rId1"/>
          <a:stretch><a:fillRect/></a:stretch>
        </p:blipFill>
        <p:spPr>
          <a:xfrm><a:off x="0" y="0"/><a:ext cx="${wEmu}" cy="${hEmu}"/></a:xfrm>
          <a:prstGeom prst="rect"><a:avLst/></a:prstGeom>
        </p:spPr>
      </p:pic>
    </p:spTree>
  </p:cSld>
</p:sld>`;
    files.push([`ppt/slides/slide${idx}.xml`, utf8(slideXml)]);

    const slideRelsXml = `${XML}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/image${idx}.${ext}"/>
</Relationships>`;
    files.push([`ppt/slides/_rels/slide${idx}.xml.rels`, utf8(slideRelsXml)]);

    files.push([`ppt/media/image${idx}.${ext}`, s.image]);
  });

  return zip(files);
}

