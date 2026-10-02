'use strict';
(() => {
  const copy = {
    'zh-Hant': { title: '私人郵件封存（僅本機）', note: '只匯入你選取的 EML／文字檔，全份加密保存；不連接 Gmail，不提供給 AI。需要桌面版的作業系統安全儲存。', choose: '匯入選定郵件', refresh: '查看本機郵件', confirm: '將這份選定郵件加密儲存在本機？不會傳送至雲端模型。', done: '已加密保存於本機。', fail: '無法讀取或保存。請確認桌面安全儲存、磁碟及檔案大小（最多 2 MB）。', empty: '尚未匯入郵件。', read: '在本機閱讀', close: '關閉' },
    'zh-Hans': { title: '私人邮件封存（仅本机）', note: '只导入你选取的 EML／文本文件，整份加密保存；不连接 Gmail，不提供给 AI。需要桌面版的操作系统安全存储。', choose: '导入选定邮件', refresh: '查看本机邮件', confirm: '将这份选定邮件加密保存在本机？不会传送至云端模型。', done: '已加密保存在本机。', fail: '无法读取或保存。请确认桌面安全存储、磁盘及文件大小（最多 2 MB）。', empty: '尚未导入邮件。', read: '在本机阅读', close: '关闭' },
    en: { title: 'Private mail archive · local only', note: 'Import only selected EML/text files. Entire records are encrypted locally, never shared with AI. No Gmail connection. Requires desktop OS-protected storage.', choose: 'Import selected mail', refresh: 'View local mail', confirm: 'Encrypt this selected mail locally? It will not be sent to a cloud model.', done: 'Encrypted and saved locally.', fail: 'Could not read or save. Check desktop secure storage, disk availability and the 2 MB file limit.', empty: 'No mail imported.', read: 'Read locally', close: 'Close' }
  };
  const section = document.createElement('section'); section.className = 'settings-section';
  const root = document.querySelector('.drawer-content'); if (!root) return; root.append(section);
  function el(tag, value, className) { const node = document.createElement(tag); if (value) node.textContent = value; if (className) node.className = className; return node; }
  const strings = () => copy[document.documentElement.lang] || copy.en;
  async function call(url, options = {}) {
    const token = sessionStorage.getItem('mmm.session') || '';
    const response = await fetch(url, { ...options, headers: { 'x-mmm-session': token, 'Content-Type': 'application/json' } });
    if (!response.ok) throw Error('LOCAL_MAIL_UNAVAILABLE'); return response.json();
  }
  function render() {
    section.replaceChildren(); const t = strings();
    section.append(el('h3', t.title), el('p', t.note, 'helper'));
    const input = document.createElement('input'); input.type = 'file'; input.accept = '.eml,.txt,message/rfc822,text/plain'; input.hidden = true;
    const choose = el('button', t.choose, 'button secondary'); choose.type = 'button';
    const refresh = el('button', t.refresh, 'button secondary'); refresh.type = 'button';
    const status = el('p'); status.setAttribute('role', 'status');
    const list = el('div'); section.append(choose, refresh, input, status, list);
    async function refreshList() {
      const result = await call('/api/private-mail'); list.replaceChildren();
      if (!result.records.length) list.append(el('p', t.empty));
      for (const record of result.records) {
        const row = el('div'), button = el('button', `${t.read}: ${record.name}`, 'text-button'); button.type = 'button';
        button.addEventListener('click', async () => {
          try {
            const mail = await call(`/api/private-mail/${encodeURIComponent(record.id)}`);
            const dialog = el('dialog'), body = el('div', '', 'dialog-body'), title = el('h2', mail.name), content = el('pre', mail.content), close = el('button', t.close, 'button secondary');
            // Never interpret mail HTML, remote images, links or attachment instructions.
            close.type = 'button'; close.addEventListener('click', () => dialog.close()); dialog.addEventListener('close', () => dialog.remove());
            body.append(title, content, close); dialog.append(body); document.body.append(dialog); dialog.showModal(); close.focus();
          } catch { status.textContent = t.fail; }
        }); row.append(button); list.append(row);
      }
    }
    choose.addEventListener('click', () => input.click());
    refresh.addEventListener('click', () => refreshList().catch(() => { status.textContent = t.fail; }));
    input.addEventListener('change', async () => {
      const file = input.files[0]; input.value = ''; if (!file) return;
      if (file.size > 2 * 1024 * 1024) { status.textContent = t.fail; return; }
      if (!window.confirm(t.confirm)) return;
      choose.disabled = true;
      try { await call('/api/private-mail', { method: 'POST', body: JSON.stringify({ name: file.name, content: await file.text(), confirmLocalOnly: true }) }); status.textContent = t.done; await refreshList(); }
      catch { status.textContent = t.fail; } finally { choose.disabled = false; }
    });
  }
  render(); new MutationObserver(render).observe(document.documentElement, { attributes: true, attributeFilter: ['lang'] });
})();
