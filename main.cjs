const { app, BrowserWindow, ipcMain, shell } = require('electron');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const dataPath = path.join(process.env.LOCALAPPDATA, 'SALE VITAGREEN V2', 'sale-data.json');
function emptyData() {
  return {
    Orders: [], Customers: [], CustomerNotes: [], FollowUps: [],
    ExternalSummary: { Daily: [], BySale: [] },
    NotificationReadDate: '', NotificationsRead: false
  };
}
function normalizeData(value) {
  const data = value && typeof value === 'object' ? value : emptyData();
  data.Orders = Array.isArray(data.Orders) ? data.Orders : [];
  data.Customers = Array.isArray(data.Customers) ? data.Customers : [];
  data.CustomerNotes = Array.isArray(data.CustomerNotes) ? data.CustomerNotes : [];
  data.FollowUps = Array.isArray(data.FollowUps) ? data.FollowUps : [];
  data.ExternalSummary = data.ExternalSummary && typeof data.ExternalSummary === 'object' ? data.ExternalSummary : { Daily: [], BySale: [] };
  data.ExternalSummary.Daily = Array.isArray(data.ExternalSummary.Daily) ? data.ExternalSummary.Daily : [];
  data.ExternalSummary.BySale = Array.isArray(data.ExternalSummary.BySale) ? data.ExternalSummary.BySale : [];
  return data;
}
function readData() {
  try {
    if (!fs.existsSync(dataPath)) {
      const initial = emptyData();
      writeData(initial);
      return initial;
    }
    return normalizeData(JSON.parse(fs.readFileSync(dataPath, 'utf8').replace(/^\uFEFF/, '')));
  } catch (error) {
    const backupPath = `${dataPath}.broken-${Date.now()}`;
    try { if (fs.existsSync(dataPath)) fs.copyFileSync(dataPath, backupPath); } catch (_) {}
    const initial = emptyData();
    writeData(initial);
    return initial;
  }
}
function writeData(data) {
  fs.mkdirSync(path.dirname(dataPath), { recursive: true });
  fs.writeFileSync(dataPath, JSON.stringify(normalizeData(data), null, 2), 'utf8');
  return { ok: true };
}
function googleCredentialPath() {
  if (process.platform === 'win32' && process.env.LOCALAPPDATA) {
    return path.join(process.env.LOCALAPPDATA, 'SALE VITAGREEN V2', 'google-service-account.json');
  }
  return path.join(app.getPath('userData'), 'google-service-account.json');
}
function sourceIdForOwner(owner) {
  return sources.find(([name]) => flat(name) === flat(owner))?.[1];
}
function base64Url(value) {
  return Buffer.from(value).toString('base64url');
}
async function googleAccessToken() {
  const credentialFile = googleCredentialPath();
  if (!fs.existsSync(credentialFile)) {
    throw new Error(`Chưa có khóa Google Service Account tại ${credentialFile}. Đơn chưa được ghi lên Sheet.`);
  }
  let credential;
  try {
    credential = JSON.parse(fs.readFileSync(credentialFile, 'utf8').replace(/^\uFEFF/, ''));
  } catch (_) {
    throw new Error('Tệp khóa Google Service Account không hợp lệ. Đơn chưa được ghi lên Sheet.');
  }
  if (!credential.client_email || !credential.private_key) {
    throw new Error('Tệp khóa Google Service Account thiếu client_email hoặc private_key.');
  }
  const now = Math.floor(Date.now() / 1000);
  const header = base64Url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claim = base64Url(JSON.stringify({
    iss: credential.client_email,
    scope: 'https://www.googleapis.com/auth/spreadsheets',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600
  }));
  const unsigned = `${header}.${claim}`;
  const signature = crypto.createSign('RSA-SHA256').update(unsigned).end().sign(credential.private_key, 'base64url');
  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: `${unsigned}.${signature}`
    })
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || !body.access_token) {
    throw new Error(`Không xác thực được Google Service Account${body.error_description ? `: ${body.error_description}` : '.'}`);
  }
  return body.access_token;
}
function sheetDateValue(date) {
  const match = String(date || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return match ? `${match[3]}/${match[2]}/${match[1]}` : String(date || '');
}
async function appendOrderToSheet(order, customer) {
  const spreadsheetId = sourceIdForOwner(order?.Owner);
  if (!spreadsheetId) throw new Error(`Chưa có link VTG_lendon của sale ${order?.Owner || ''}.`);
  const accessToken = await googleAccessToken();
  const deliveryStatus = order.Status === 'Thành công' ? 'Giao thành công' : order.Status;
  // Cột M của một số sheet là công thức/vùng bảo vệ, nên không ghi hoặc chèn dòng qua cột này.
  // Tìm dòng trống tiếp theo rồi chỉ ghi các cột được phép: A:L và N:Q.
  const leftRow = [[
    sheetDateValue(order.Date), customer?.Name || order.CustomerName || '', String(order.CustomerPhone || ''), customer?.Address || '',
    order.Product || '', Number(order.Quantity) || 0, '', '', '', '', deliveryStatus || 'Đã lên đơn',
    order.Type || 'Khách mới'
  ]];
  const usedRowsResponse = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${encodeURIComponent('VTG_lendon!A:A')}`, {
    headers: { Authorization: `Bearer ${accessToken}` }, signal: AbortSignal.timeout(20000)
  });
  const usedRowsBody = await usedRowsResponse.json().catch(() => ({}));
  if (!usedRowsResponse.ok) throw new Error(`Không xác định được dòng trống trên Google Sheet: ${usedRowsBody.error?.message || `mã ${usedRowsResponse.status}`}`);
  const rowNumber = Math.max(2, (usedRowsBody.values || []).length + 1);
  const response = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values:batchUpdate`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(20000),
    body: JSON.stringify({
      valueInputOption: 'USER_ENTERED',
      data: [
        { range: `VTG_lendon!A${rowNumber}:L${rowNumber}`, values: leftRow },
        { range: `VTG_lendon!N${rowNumber}:Q${rowNumber}`, values: [[order.Id || '', Number(order.Amount) || 0, order.Type || 'Khách mới', 'Đơn tạo từ SALE VITAGREEN V2']] }
      ]
    })
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const detail = body.error?.message || `mã ${response.status}`;
    throw new Error(`Google Sheet từ chối ghi đơn: ${detail}`);
  }
  return { ok: true, range: `VTG_lendon!A${rowNumber}:Q${rowNumber}` };
}
async function cancelOrderInSheet(order) {
  const spreadsheetId = sourceIdForOwner(order?.Owner);
  if (!spreadsheetId) throw new Error(`Chưa có link VTG_lendon của sale ${order?.Owner || ''}.`);
  if (!order?.Id) throw new Error('Đơn hàng chưa có mã đơn để đối chiếu trên Google Sheet.');
  const accessToken = await googleAccessToken();
  const codeRange = encodeURIComponent('VTG_lendon!N:N');
  const lookup = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${codeRange}`, {
    headers: { Authorization: `Bearer ${accessToken}` }
  });
  const lookupBody = await lookup.json().catch(() => ({}));
  if (!lookup.ok) throw new Error(`Không đọc được mã đơn trên Google Sheet: ${lookupBody.error?.message || `mã ${lookup.status}`}`);
  const rowIndex = (lookupBody.values || []).findIndex(row => String(row?.[0] || '').trim() === String(order.Id).trim()) + 1;
  if (!rowIndex) throw new Error(`Không tìm thấy mã đơn ${order.Id} trong VTG_lendon.`);
  const statusRange = encodeURIComponent(`VTG_lendon!K${rowIndex}`);
  const update = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${statusRange}?valueInputOption=USER_ENTERED`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ values: [['Hủy']] })
  });
  const updateBody = await update.json().catch(() => ({}));
  if (!update.ok) throw new Error(`Google Sheet từ chối hủy đơn: ${updateBody.error?.message || `mã ${update.status}`}`);
  return { ok: true, range: updateBody.updatedRange || `VTG_lendon!K${rowIndex}` };
}
const sources = [
  ['Thu','1l0T4TKTQsSGOKntxeDqK8UJV6khh2Taka50ou35mFSY'], ['Chang','1-CA2qhRN2S4eDXuCV-znuDByfyStK7Tt_y9dOdqbph4'],
  ['Lương','1CJrdWnA291kYg9kgq_P9Xa_QfA4T0TTkVEIm7w46Nsk'], ['Phương','1SOeryGnc-8y-_QOFWkTxrmRYY0ui_BXGgA5dFPLYhSo'],
  ['Thùy','1aPrDB0H-a8geNZZeapIHaPuKmozej_v-aYL8u_DTaWc'], ['Mỹ Anh','1ta8dH-SWJ88BGyR15pycpcEhb0DLHOc0QfU9O3nGmvo'],
  ['Tuyết','1ATC0glShD5jtmf7eE8KmtBUSHnI5a6uYw5OP70IGVPg']
];
const flat = value => String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
const cell = (row, index) => row.c?.[index]?.f ?? row.c?.[index]?.v ?? '';
function sheetDate(row) { const raw=String(row.c?.[0]?.v || ''), shown=String(cell(row,0)); let m=raw.match(/^Date\((\d+),(\d+),(\d+)/); if(m) return `${m[1]}-${String(+m[2]+1).padStart(2,'0')}-${String(m[3]).padStart(2,'0')}`; m=shown.match(/^(\d{1,2})\/(\d{1,2})(?:\/(\d{4}))?$/); return m ? `${m[3]||2026}-${String(m[2]).padStart(2,'0')}-${String(m[1]).padStart(2,'0')}` : null; }
function amount(row) { const value=row.c?.[14]?.v; if(typeof value==='number') return value; return Number(String(cell(row,14)).replace(/\D/g,'')) || 0; }
function total(rows,key) { return rows.reduce((sum,row)=>sum+(Number(row[key])||0),0); }
async function readSource(owner, id) {
  const url=`https://docs.google.com/spreadsheets/d/${id}/gviz/tq?tqx=out:json&sheet=VTG_lendon`;
  const response=await fetch(url,{signal:AbortSignal.timeout(15000)}); if(!response.ok) throw new Error(`Không đọc được Sheet ${owner}`); const body=await response.text(), match=body.match(/\{[\s\S]*\}/); if(!match) throw new Error(`Không đọc được Sheet ${owner}`);
  const grid=JSON.parse(match[0]); const orders=[];
  for(const row of grid.table.rows || []) { const date=sheetDate(row); if(!date || date<'2026-01-01') continue; const idOrder=String(cell(row,13)).trim(); if(!idOrder) continue;
    const statusText=flat(cell(row,10)), classText=flat(cell(row,11)) || flat(cell(row,15));
    const status=statusText.includes('huy')?'Hủy':statusText.includes('hoan')?'Hoàn':statusText.includes('thanh cong')?'Thành công':statusText.includes('len don')?'Đã lên đơn':String(cell(row,10)).trim()||'Chờ xử lý';
    orders.push({Id:idOrder,CustomerName:String(cell(row,1)),CustomerPhone:String(cell(row,2)).replace(/\D/g,''),Owner:owner,Product:String(cell(row,4)),Quantity:String(cell(row,5)),Amount:amount(row),Date:date,Status:status,Type:classText.includes('cu')||classText.includes('mua lai')||classText.includes('toi')?'Khách cũ':'Khách mới',ImportedFrom:`VTG_lendon | ${id}`});
  } return orders;
}
function buildSummary(orders) { const daily=[], bySale=[], owners=['Thu','Chang','Lương','Phương','Thùy','Mỹ Anh','Tuyết'], dates=orders.map(o=>o.Date).filter(Boolean).sort(), start=dates[0]||new Date().toISOString().slice(0,10), end=dates[dates.length-1]||start; for(let time=new Date(`${start}T00:00:00Z`).getTime();time<=new Date(`${end}T00:00:00Z`).getTime();time+=86400000){const date=new Date(time).toISOString().slice(0,10); for(const owner of [null,...owners]){const rows=orders.filter(o=>o.Date===date&&(!owner||o.Owner===owner)), returns=rows.filter(o=>o.Status==='Hoàn'||o.Status==='Hủy'), valid=rows.filter(o=>o.Status!=='Hoàn'&&o.Status!=='Hủy'), fresh=valid.filter(o=>o.Type==='Khách mới'), old=valid.filter(o=>o.Type==='Khách cũ'); const item={Date:date,Data:null,NewOrders:fresh.length,OldOrders:old.length,NewRevenue:total(fresh,'Amount'),OldRevenue:total(old,'Amount'),ReturnCount:returns.length,ReturnRevenue:total(returns,'Amount'),NetRevenue:total(valid,'Amount'),OrderCount:valid.length}; if(owner) bySale.push({...item,Owner:owner}); else daily.push(item); }} return {Source:'VTG_lendon – đồng bộ đọc-only',DataNote:'Chỉ đọc dữ liệu từ các link sale; không ghi hay sửa Google Sheet.',LastImportedAt:new Date().toISOString(),Daily:daily,BySale:bySale}; }
async function syncGoogle() {
  const results = await Promise.allSettled(sources.map(([owner, id]) => readSource(owner, id)));
  const failed = results.filter(result => result.status === 'rejected');
  const imported = results.filter(result => result.status === 'fulfilled').flatMap(result => result.value);
  if (!imported.length) {
    const reason = failed[0]?.reason?.message || 'Không đọc được dữ liệu từ Google Sheet.';
    throw new Error(reason);
  }
  const data = readData();
  const sourceOwners = new Set([...sources.map(x => x[0]), 'Thủy']);
  const existingCustomers = new Map(data.Customers.map(c => [c.Phone, c]));
  data.Orders = [...data.Orders.filter(o => !(o.ImportedFrom && sourceOwners.has(o.Owner))), ...imported];
  const phones = new Set();
  data.Customers = data.Orders.sort((a,b) => a.Date.localeCompare(b.Date)).filter(o => o.CustomerPhone && !phones.has(o.CustomerPhone) && (phones.add(o.CustomerPhone), true)).map(o => ({ ...existingCustomers.get(o.CustomerPhone), Id: `KH-${o.CustomerPhone}`, Name: o.CustomerName, Phone: o.CustomerPhone, Owner: o.Owner, Source: 'VTG_lendon', Note: existingCustomers.get(o.CustomerPhone)?.Note || '', Created: o.Date }));
  data.ExternalSummary = buildSummary(data.Orders);
  writeData(data);
  return { orders: imported.length, sales: results.length - failed.length, failed: failed.length };
}
const reportSources={Thu:'1l0T4TKTQsSGOKntxeDqK8UJV6khh2Taka50ou35mFSY',Chang:'1-CA2qhRN2S4eDXuCV-znuDByfyStK7Tt_y9dOdqbph4',Lương:'1CJrdWnA291kYg9kgq_P9Xa_QfA4T0TTkVEIm7w46Nsk',Phương:'1SOeryGnc-8y-_QOFWkTxrmRYY0ui_BXGgA5dFPLYhSo',Thủy:'1aPrDB0H-a8geNZZeapIHaPuKmozej_v-aYL8u_DTaWc',Thùy:'1aPrDB0H-a8geNZZeapIHaPuKmozej_v-aYL8u_DTaWc','Mỹ Anh':'1ta8dH-SWJ88BGyR15pycpcEhb0DLHOc0QfU9O3nGmvo',Tuyết:'1ATC0glShD5jtmf7eE8KmtBUSHnI5a6uYw5OP70IGVPg'};
async function syncReportSale(owner){if(owner==='Tất cả')return syncGoogle();const id=reportSources[owner];if(!id)throw new Error('Chưa có link Google Sheet của sale này.');const imported=await readSource(owner,id),data=readData();data.Orders=[...(data.Orders||[]).filter(o=>o.Owner!==owner),...imported];data.ExternalSummary=buildSummary(data.Orders);writeData(data);return {orders:imported.length,sales:1};}
const releaseApi='https://api.github.com/repos/quangtungkc/sale-vitagreen-v2/releases/latest';
const versionNumber=value=>String(value||'').replace(/^v/,'').split('.').map(Number);
const newer=(remote,local)=>{const a=versionNumber(remote),b=versionNumber(local);for(let i=0;i<3;i++){if((a[i]||0)!==(b[i]||0))return (a[i]||0)>(b[i]||0)}return false};
async function latestRelease() { const response=await fetch(releaseApi,{headers:{Accept:'application/vnd.github+json'}}); if(!response.ok) throw new Error('Không kiểm tra được GitHub Release.'); return response.json(); }
async function checkUpdate() { const release=await latestRelease(); return {available:newer(release.tag_name,app.getVersion()),version:release.tag_name,url:release.html_url}; }
async function installUpdate() {
  const release = await latestRelease();
  if (!newer(release.tag_name, app.getVersion())) return { available: false, version: app.getVersion() };
  const asset = (release.assets || []).find(x => /\.exe$/i.test(x.name));
  if (!asset) throw new Error('Release chưa có bộ cài Windows.');
  const updateFolder = path.join(app.getPath('temp'), 'SALE VITAGREEN V2 Updates');
  fs.mkdirSync(updateFolder, { recursive: true });
  const file = path.join(updateFolder, asset.name);
  const partial = `${file}.download`;
  const response = await fetch(asset.browser_download_url, { redirect: 'follow' });
  if (!response.ok) throw new Error(`Không tải được bộ cài mới (mã ${response.status}).`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length < 1024 * 1024) throw new Error('Bộ cài tải về không đầy đủ. Vui lòng thử lại.');
  fs.writeFileSync(partial, bytes);
  fs.renameSync(partial, file);
  const result = await shell.openPath(file);
  if (result) throw new Error(`Windows không mở được bộ cài: ${result}`);
  return { available: true, version: release.tag_name, file };
}
function createWindow() {
  const win = new BrowserWindow({ width: 1480, height: 920, minWidth: 1120, minHeight: 720, backgroundColor: '#f4f7fb', webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true } });
  win.webContents.on('console-message', (_, level, message) => console.log(`[renderer:${level}] ${message}`));
  win.loadFile('index.html');
}
ipcMain.handle('app:data', () => readData());
ipcMain.handle('app:save', (_, data) => writeData(data));
ipcMain.handle('app:sync-google', () => syncGoogle());
ipcMain.handle('app:append-order-sheet', (_, order, customer) => appendOrderToSheet(order, customer));
ipcMain.handle('app:cancel-order-sheet', (_, order) => cancelOrderInSheet(order));
ipcMain.handle('app:sync-report-sale', (_, owner) => syncReportSale(owner));
ipcMain.handle('app:check-update', () => checkUpdate());
ipcMain.handle('app:install-update', () => installUpdate());
ipcMain.handle('app:send-zalo-report', async (_, report) => {
  const zalo = readData().ZaloOA;
  if (!zalo?.accessToken || !zalo?.groupId) {
    return { ok: false, message: 'Chưa cấu hình Zalo OA và nhóm GMF nhận báo cáo. Cần kết nối OA OpenAPI trước khi gửi tự động.' };
  }
  return { ok: false, message: 'Kết nối Zalo OA chưa hoàn tất. Không gửi dữ liệu khi chưa xác thực đầy đủ.' };
});
app.whenReady().then(createWindow);
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
