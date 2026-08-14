const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('vitagreen', {
  getData: () => ipcRenderer.invoke('app:data'),
  saveData: (data) => ipcRenderer.invoke('app:save', data),
  syncGoogle: () => ipcRenderer.invoke('app:sync-google'),
  appendOrderToSheet: (order, customer, session) => ipcRenderer.invoke('app:append-order-sheet', order, customer, session),
  cancelOrderInSheet: (order, session) => ipcRenderer.invoke('app:cancel-order-sheet', order, session),
  syncReportSale: (owner) => ipcRenderer.invoke('app:sync-report-sale', owner),
  checkUpdate: () => ipcRenderer.invoke('app:check-update'),
  installUpdate: () => ipcRenderer.invoke('app:install-update'),
  sendZaloReport: (report) => ipcRenderer.invoke('app:send-zalo-report', report)
});
