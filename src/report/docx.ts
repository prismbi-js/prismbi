/**
 * Minimal, zero-dependency Word (.docx) document generator.
 * Packages executive summaries, tables, and visual chart snapshots into an OpenXML document.
 * Compatible with Microsoft Word, Google Docs, Apple Pages, and LibreOffice Writer.
 */
import type { CellValue } from '../data/types';
import { zip } from './xlsx';

export interface DocxTable {
  headers: string[];
  rows: CellValue[][];
  title?: string;
}

export interface DocxSection {
  heading?: string;
  text?: string;
  table?: DocxTable;
  image?: {
    data: Uint8Array;
    format?: 'png' | 'jpeg';
    width?: number;
    height?: number;
  };
}

export interface DocxDocument {
  title: string;
  subtitle?: string;
  date?: string;
  author?: string;
  sections: DocxSection[];
}

export const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

const XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
const enc = new TextEncoder();
const utf8 = (s: string) => enc.encode(s);
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const EMU_PER_PX = 9525;

/** Build a standalone .docx file from sections, tables, and images. */
export function buildDocx(doc: DocxDocument): Uint8Array {
  const files: [string, Uint8Array][] = [];
  const images: { id: string; target: string; data: Uint8Array; widthEmu: number; heightEmu: number }[] = [];

  let imgIndex = 1;
  for (const sec of doc.sections) {
    if (sec.image) {
      const ext = sec.image.format === 'jpeg' ? 'jpeg' : 'png';
      const id = `rIdImg${imgIndex}`;
      const target = `media/image${imgIndex}.${ext}`;
      const w = Math.round((sec.image.width ?? 600) * EMU_PER_PX);
      const h = Math.round((sec.image.height ?? 340) * EMU_PER_PX);
      images.push({ id, target, data: sec.image.data, widthEmu: w, heightEmu: h });
      files.push([`word/${target}`, sec.image.data]);
      imgIndex++;
    }
  }

  // 1. [Content_Types].xml
  const contentTypesXml = `${XML}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Default Extension="jpeg" ContentType="image/jpeg"/>
  <Default Extension="jpg" ContentType="image/jpeg"/>
  <Default Extension="png" ContentType="image/png"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
  <Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
</Types>`;
  files.push(['[Content_Types].xml', utf8(contentTypesXml)]);

  // 2. _rels/.rels
  const rootRelsXml = `${XML}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`;
  files.push(['_rels/.rels', utf8(rootRelsXml)]);

  // 3. word/_rels/document.xml.rels
  const docRelsXml = `${XML}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rIdStyles" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
${images.map((img) => `  <Relationship Id="${img.id}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="${img.target}"/>`).join('\n')}
</Relationships>`;
  files.push(['word/_rels/document.xml.rels', utf8(docRelsXml)]);

  // 4. word/styles.xml
  const stylesXml = `${XML}<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:docDefaults>
    <w:rPrDefault>
      <w:rPr>
        <w:rFonts w:ascii="Calibri" w:hAnsi="Calibri"/>
        <w:sz w:val="22"/>
        <w:color w:val="222222"/>
      </w:rPr>
    </w:rPrDefault>
  </w:docDefaults>
  <w:style w:type="paragraph" w:styleId="Title">
    <w:name w:val="Title"/>
    <w:rPr>
      <w:rFonts w:ascii="Calibri" w:hAnsi="Calibri"/>
      <w:b/>
      <w:sz w:val="52"/>
      <w:color w:val="111111"/>
    </w:rPr>
  </w:style>
  <w:style w:type="paragraph" w:styleId="Heading1">
    <w:name w:val="Heading 1"/>
    <w:rPr>
      <w:rFonts w:ascii="Calibri" w:hAnsi="Calibri"/>
      <w:b/>
      <w:sz w:val="36"/>
      <w:color w:val="1A5FB4"/>
    </w:rPr>
  </w:style>
  <w:style w:type="paragraph" w:styleId="Heading2">
    <w:name w:val="Heading 2"/>
    <w:rPr>
      <w:rFonts w:ascii="Calibri" w:hAnsi="Calibri"/>
      <w:b/>
      <w:sz w:val="28"/>
      <w:color w:val="333333"/>
    </w:rPr>
  </w:style>
</w:styles>`;
  files.push(['word/styles.xml', utf8(stylesXml)]);

  // 5. word/document.xml
  let currentImg = 0;
  const bodyXml: string[] = [];

  // Title
  bodyXml.push(`  <w:p><w:pPr><w:pStyle w:val="Title"/><w:spacing w:after="160"/></w:pPr><w:r><w:t>${esc(doc.title)}</w:t></w:r></w:p>`);

  // Subtitle / Date metadata
  if (doc.subtitle || doc.date || doc.author) {
    const metaParts = [doc.subtitle, doc.date, doc.author].filter(Boolean).map((s) => esc(s!));
    bodyXml.push(`  <w:p><w:pPr><w:spacing w:after="360"/></w:pPr><w:r><w:rPr><w:i/><w:color w:val="666666"/></w:rPr><w:t>${metaParts.join('  •  ')}</w:t></w:r></w:p>`);
  }

  // Sections
  for (const sec of doc.sections) {
    if (sec.heading) {
      bodyXml.push(`  <w:p><w:pPr><w:pStyle w:val="Heading1"/><w:spacing w:before="240" w:after="120"/></w:pPr><w:r><w:t>${esc(sec.heading)}</w:t></w:r></w:p>`);
    }
    if (sec.text) {
      const paragraphs = sec.text.split('\n\n');
      for (const p of paragraphs) {
        bodyXml.push(`  <w:p><w:pPr><w:spacing w:after="160"/></w:pPr><w:r><w:t>${esc(p)}</w:t></w:r></w:p>`);
      }
    }
    if (sec.image) {
      const img = images[currentImg++];
      const drawingXml = `  <w:p>
    <w:pPr><w:spacing w:after="240"/><w:jc w:val="center"/></w:pPr>
    <w:r>
      <w:drawing>
        <wp:inline distT="0" distB="0" distL="0" distR="0" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing">
          <wp:extent cx="${img.widthEmu}" cy="${img.heightEmu}"/>
          <wp:docPr id="${currentImg}" name="Chart ${currentImg}"/>
          <a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">
            <a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">
              <pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture">
                <pic:nvPicPr>
                  <pic:cNvPr id="${currentImg}" name="Picture ${currentImg}"/>
                  <pic:cNvPicPr/>
                </pic:nvPicPr>
                <pic:blipFill>
                  <a:blip r:embed="${img.id}" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"/>
                  <a:stretch><a:fillRect/></a:stretch>
                </pic:blipFill>
                <pic:spPr>
                  <a:xfrm><a:off x="0" y="0"/><a:ext cx="${img.widthEmu}" cy="${img.heightEmu}"/></a:xfrm>
                  <a:prstGeom prst="rect"><a:avLst/></a:prstGeom>
                </pic:spPr>
              </pic:pic>
            </a:graphicData>
          </a:graphic>
        </wp:inline>
      </w:drawing>
    </w:r>
  </w:p>`;
      bodyXml.push(drawingXml);
    }
    if (sec.table) {
      if (sec.table.title) {
        bodyXml.push(`  <w:p><w:pPr><w:pStyle w:val="Heading2"/><w:spacing w:before="120" w:after="80"/></w:pPr><w:r><w:t>${esc(sec.table.title)}</w:t></w:r></w:p>`);
      }
      const t = sec.table;
      const tblXml: string[] = [];
      tblXml.push(`  <w:tbl>
    <w:tblPr>
      <w:tblW w:w="5000" w:type="pct"/>
      <w:tblBorders>
        <w:top w:val="single" w:sz="4" w:space="0" w:color="D3D3D3"/>
        <w:left w:val="none"/>
        <w:bottom w:val="single" w:sz="8" w:space="0" w:color="999999"/>
        <w:right w:val="none"/>
        <w:insideH w:val="single" w:sz="4" w:space="0" w:color="E5E5E5"/>
        <w:insideV w:val="none"/>
      </w:tblBorders>
    </w:tblPr>`);

      // Header row
      tblXml.push(`    <w:tr>
      <w:trPr><w:tblHeader/></w:trPr>
${t.headers.map((h) => `      <w:tc>
        <w:tcPr>
          <w:shd w:val="clear" w:color="auto" w:fill="F2F4F7"/>
          <w:tcMar><w:top w:w="120" w:type="dxa"/><w:bottom w:w="120" w:type="dxa"/><w:left w:w="120" w:type="dxa"/><w:right w:w="120" w:type="dxa"/></w:tcMar>
        </w:tcPr>
        <w:p><w:r><w:rPr><w:b/><w:sz w:val="20"/></w:rPr><w:t>${esc(String(h))}</w:t></w:r></w:p>
      </w:tc>`).join('\n')}
    </w:tr>`);

      // Data rows
      for (const row of t.rows) {
        tblXml.push(`    <w:tr>
${row.map((val) => `      <w:tc>
        <w:tcPr>
          <w:tcMar><w:top w:w="100" w:type="dxa"/><w:bottom w:w="100" w:type="dxa"/><w:left w:w="120" w:type="dxa"/><w:right w:w="120" w:type="dxa"/></w:tcMar>
        </w:tcPr>
        <w:p><w:r><w:rPr><w:sz w:val="20"/></w:rPr><w:t>${esc(val === null || val === undefined ? '' : val instanceof Date ? val.toLocaleDateString() : String(val))}</w:t></w:r></w:p>
      </w:tc>`).join('\n')}
    </w:tr>`);
      }
      tblXml.push('  </w:tbl>');
      bodyXml.push(tblXml.join('\n'));
      bodyXml.push('  <w:p><w:pPr><w:spacing w:after="240"/></w:pPr></w:p>');
    }
  }

  const documentXml = `${XML}<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<w:body>
${bodyXml.join('\n')}
  <w:sectPr>
    <w:pgSz w:w="12240" w:h="15840"/>
    <w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/>
  </w:sectPr>
</w:body>
</w:document>`;
  files.push(['word/document.xml', utf8(documentXml)]);

  return zip(files);
}

