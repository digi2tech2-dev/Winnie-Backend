'use strict';

const path = require('path');

const XML_HEADER = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';

const crcTable = (() => {
    const table = new Uint32Array(256);
    for (let i = 0; i < 256; i += 1) {
        let c = i;
        for (let j = 0; j < 8; j += 1) {
            c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
        }
        table[i] = c >>> 0;
    }
    return table;
})();

const crc32 = (buffer) => {
    let crc = 0xFFFFFFFF;
    for (const byte of buffer) {
        crc = crcTable[(crc ^ byte) & 0xFF] ^ (crc >>> 8);
    }
    return (crc ^ 0xFFFFFFFF) >>> 0;
};

const dosDateTime = (date = new Date()) => {
    const year = Math.max(date.getFullYear(), 1980);
    const dosTime = (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2);
    const dosDate = ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
    return { dosDate, dosTime };
};

const createZip = (files) => {
    const localParts = [];
    const centralParts = [];
    let offset = 0;
    const now = dosDateTime();

    for (const file of files) {
        const name = Buffer.from(file.name.replace(/\\/g, '/'));
        const data = Buffer.isBuffer(file.data) ? file.data : Buffer.from(String(file.data), 'utf8');
        const crc = crc32(data);

        const local = Buffer.alloc(30);
        local.writeUInt32LE(0x04034b50, 0);
        local.writeUInt16LE(20, 4);
        local.writeUInt16LE(0x0800, 6);
        local.writeUInt16LE(0, 8);
        local.writeUInt16LE(now.dosTime, 10);
        local.writeUInt16LE(now.dosDate, 12);
        local.writeUInt32LE(crc, 14);
        local.writeUInt32LE(data.length, 18);
        local.writeUInt32LE(data.length, 22);
        local.writeUInt16LE(name.length, 26);
        local.writeUInt16LE(0, 28);

        localParts.push(local, name, data);

        const central = Buffer.alloc(46);
        central.writeUInt32LE(0x02014b50, 0);
        central.writeUInt16LE(20, 4);
        central.writeUInt16LE(20, 6);
        central.writeUInt16LE(0x0800, 8);
        central.writeUInt16LE(0, 10);
        central.writeUInt16LE(now.dosTime, 12);
        central.writeUInt16LE(now.dosDate, 14);
        central.writeUInt32LE(crc, 16);
        central.writeUInt32LE(data.length, 20);
        central.writeUInt32LE(data.length, 24);
        central.writeUInt16LE(name.length, 28);
        central.writeUInt16LE(0, 30);
        central.writeUInt16LE(0, 32);
        central.writeUInt16LE(0, 34);
        central.writeUInt16LE(0, 36);
        central.writeUInt32LE(0, 38);
        central.writeUInt32LE(offset, 42);
        centralParts.push(central, name);

        offset += local.length + name.length + data.length;
    }

    const centralSize = centralParts.reduce((sum, part) => sum + part.length, 0);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(0, 4);
    end.writeUInt16LE(0, 6);
    end.writeUInt16LE(files.length, 8);
    end.writeUInt16LE(files.length, 10);
    end.writeUInt32LE(centralSize, 12);
    end.writeUInt32LE(offset, 16);
    end.writeUInt16LE(0, 20);

    return Buffer.concat([...localParts, ...centralParts, end]);
};

const escapeXml = (value) => String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');

const columnName = (index) => {
    let n = index + 1;
    let name = '';
    while (n > 0) {
        const rem = (n - 1) % 26;
        name = String.fromCharCode(65 + rem) + name;
        n = Math.floor((n - 1) / 26);
    }
    return name;
};

const normalizeSheetName = (name, index) => {
    const safe = String(name || `Sheet ${index + 1}`).replace(/[\\/?*[\]:]/g, ' ').slice(0, 31).trim();
    return safe || `Sheet ${index + 1}`;
};

const normalizeCell = (cell) => {
    if (cell && typeof cell === 'object' && !Array.isArray(cell) && Object.prototype.hasOwnProperty.call(cell, 'value')) {
        return cell;
    }
    return { value: cell };
};

const renderCell = (cell, rowIndex, colIndex, boldRow) => {
    const normalized = normalizeCell(cell);
    const value = normalized.value;
    if (value === null || value === undefined || value === '') return '';

    const ref = `${columnName(colIndex)}${rowIndex}`;
    const style = normalized.bold || boldRow ? ' s="1"' : '';

    if (typeof value === 'number' && Number.isFinite(value)) {
        return `<c r="${ref}"${style}><v>${value}</v></c>`;
    }

    if (typeof value === 'boolean') {
        return `<c r="${ref}" t="b"${style}><v>${value ? 1 : 0}</v></c>`;
    }

    return `<c r="${ref}" t="inlineStr"${style}><is><t>${escapeXml(value)}</t></is></c>`;
};

const renderWorksheet = (sheet) => {
    const rows = sheet.rows || [];
    const columnCount = rows.reduce((max, row) => Math.max(max, (row.cells || row || []).length), 0);
    const widths = Array.from({ length: columnCount }, (_, col) => {
        const width = rows.reduce((max, row) => {
            const cells = row.cells || row || [];
            const value = normalizeCell(cells[col]).value;
            return Math.max(max, String(value ?? '').length);
        }, 8);
        return Math.min(Math.max(width + 2, 10), 48);
    });

    const colsXml = widths.length
        ? `<cols>${widths.map((width, index) => `<col min="${index + 1}" max="${index + 1}" width="${width}" customWidth="1"/>`).join('')}</cols>`
        : '';

    const freezeRow = sheet.freezeRow || 0;
    const freezeXml = freezeRow
        ? `<sheetViews><sheetView workbookViewId="0"><pane ySplit="${freezeRow}" topLeftCell="A${freezeRow + 1}" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>`
        : '<sheetViews><sheetView workbookViewId="0"/></sheetViews>';

    const rowXml = rows.map((row, index) => {
        const rowIndex = index + 1;
        const cells = row.cells || row || [];
        const bold = Boolean(row.bold);
        return `<row r="${rowIndex}">${cells.map((cell, colIndex) => renderCell(cell, rowIndex, colIndex, bold)).join('')}</row>`;
    }).join('');

    return `${XML_HEADER}<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">${freezeXml}${colsXml}<sheetData>${rowXml}</sheetData></worksheet>`;
};

const contentTypesXml = (sheetCount) => `${XML_HEADER}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>${Array.from({ length: sheetCount }, (_, index) => `<Override PartName="/xl/worksheets/sheet${index + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')}</Types>`;

const rootRelsXml = `${XML_HEADER}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`;

const workbookXml = (sheets) => `${XML_HEADER}<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${sheets.map((sheet, index) => `<sheet name="${escapeXml(sheet.name)}" sheetId="${index + 1}" r:id="rId${index + 1}"/>`).join('')}</sheets></workbook>`;

const workbookRelsXml = (sheetCount) => `${XML_HEADER}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${Array.from({ length: sheetCount }, (_, index) => `<Relationship Id="rId${index + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${index + 1}.xml"/>`).join('')}<Relationship Id="rId${sheetCount + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`;

const stylesXml = `${XML_HEADER}<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs></styleSheet>`;

const createWorkbookBuffer = (inputSheets) => {
    const sheets = inputSheets.map((sheet, index) => ({
        ...sheet,
        name: normalizeSheetName(sheet.name, index),
    }));

    const files = [
        { name: '[Content_Types].xml', data: contentTypesXml(sheets.length) },
        { name: path.posix.join('_rels', '.rels'), data: rootRelsXml },
        { name: path.posix.join('xl', 'workbook.xml'), data: workbookXml(sheets) },
        { name: path.posix.join('xl', '_rels', 'workbook.xml.rels'), data: workbookRelsXml(sheets.length) },
        { name: path.posix.join('xl', 'styles.xml'), data: stylesXml },
        ...sheets.map((sheet, index) => ({
            name: path.posix.join('xl', 'worksheets', `sheet${index + 1}.xml`),
            data: renderWorksheet(sheet),
        })),
    ];

    return createZip(files);
};

module.exports = { createWorkbookBuffer };
