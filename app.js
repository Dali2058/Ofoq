(() => {
  const $ = (s) => document.querySelector(s);
  const state = { user: null, chats: [], chatId: null, pending: [], busy: false, mode: 'login' };

  // ---------- أدوات ----------
  async function api(path, { method = 'GET', body } = {}) {
    const opts = { method, credentials: 'same-origin', headers: {} };
    if (body instanceof FormData) opts.body = body;
    else if (body !== undefined) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
    const r = await fetch('/api' + path, opts);
    const data = await r.json().catch(() => ({}));
    if (!r.ok) { const e = new Error(data.error || 'حصل خطأ'); e.status = r.status; throw e; }
    return data;
  }

  const FORMAT_ICON = { docx: '📝', pdf: '📕', xlsx: '📊', pptx: '🎞️', csv: '📊', md: '📄', txt: '📄' };

  DOMPurify.addHook('afterSanitizeAttributes', (node) => {
    if (node.tagName === 'A') { node.setAttribute('target', '_blank'); node.setAttribute('rel', 'noopener noreferrer'); }
  });
  function renderMd(text) {
    const html = DOMPurify.sanitize(marked.parse(text, { gfm: true, breaks: true }));
    const box = document.createElement('div');
    box.className = 'md';
    box.innerHTML = html;
    box.querySelectorAll('pre').forEach((pre) => {
      const btn = document.createElement('button');
      btn.type = 'button'; btn.className = 'copy-btn'; btn.textContent = 'نسخ';
      btn.addEventListener('click', async () => {
        try { await navigator.clipboard.writeText(pre.querySelector('code')?.innerText ?? pre.innerText); btn.textContent = 'تم ✓'; }
        catch { btn.textContent = 'تعذّر'; }
        setTimeout(() => (btn.textContent = 'نسخ'), 1500);
      });
      pre.appendChild(btn);
    });
    return box;
  }

  function fileCard(f) {
    const a = document.createElement('a');
    a.className = 'filecard';
    a.href = '/api/files/' + encodeURIComponent(f.id);
    a.setAttribute('download', f.name);
    a.innerHTML = '<span></span><span class="nm"></span><span class="dl">تنزيل</span>';
    a.children[0].textContent = FORMAT_ICON[f.format] || '📄';
    a.children[1].textContent = f.name;
    return a;
  }

  function scrollDown() { const m = $('#messages'); m.scrollTop = m.scrollHeight; }

  // ---------- العرض ----------
  function addMessage(role, content, { attachments = [], files = [] } = {}) {
    $('#welcome')?.remove();
    const wrap = document.createElement('div');
    wrap.className = 'msg ' + role;
    const av = document.createElement('div');
    av.className = 'avatar'; av.textContent = role === 'user' ? (state.user?.name?.[0] || 'أ') : '◐';
    const bubble = document.createElement('div');
    bubble.className = 'bubble';
    if (role === 'user') {
      const t = document.createElement('div'); t.className = 'txt'; t.textContent = content; bubble.appendChild(t);
      for (const a of attachments) { const c = document.createElement('div'); c.className = 'chip'; c.textContent = (a.kind === 'image' ? '🖼️ ' : '📎 ') + a.name; bubble.appendChild(c); }
    } else {
      if (content) bubble.appendChild(renderMd(content));
      for (const f of files) bubble.appendChild(fileCard(f));
    }
    wrap.append(av, bubble);
    $('#messages').appendChild(wrap);
    scrollDown();
    return bubble;
  }

  function renderChatList() {
    const list = $('#chat-list');
    list.textContent = '';
    for (const c of state.chats) {
      const row = document.createElement('div');
      row.className = 'chat-item' + (c.id === state.chatId ? ' active' : '');
      const t = document.createElement('button'); t.className = 't'; t.type = 'button'; t.textContent = c.title;
      t.addEventListener('click', () => { openChat(c.id); closeSide(); });
      const d = document.createElement('button'); d.className = 'del'; d.type = 'button'; d.textContent = '🗑'; d.setAttribute('aria-label', 'حذف المحادثة');
      d.addEventListener('click', async () => {
        if (!confirm('تحذف المحادثة دي وملفاتها؟')) return;
        await api('/chats/' + c.id, { method: 'DELETE' }).catch(() => {});
        if (state.chatId === c.id) newChat();
        loadChats();
      });
      row.append(t, d);
      list.appendChild(row);
    }
  }

  function renderUser() {
    const u = state.user;
    $('#user-name').textContent = u.name;
    $('#plan-label').textContent = 'خطة ' + u.planLabel;
    $('#usage-text').textContent = `${u.usedToday} / ${u.dailyLimit}`;
    $('#usage-bar').style.width = Math.min(100, (u.usedToday / u.dailyLimit) * 100) + '%';
  }

  function resetWelcome() {
    const m = $('#messages');
    m.textContent = '';
    m.appendChild(welcomeEl);
  }

  // ---------- المحادثات ----------
  async function loadChats() { state.chats = (await api('/chats')).chats; renderChatList(); }

  async function openChat(id) {
    const data = await api('/chats/' + id);
    state.chatId = id;
    $('#chat-title').textContent = data.chat.title;
    $('#messages').textContent = '';
    for (const m of data.messages) addMessage(m.role, m.content, m);
    if (!data.messages.length) resetWelcome();
    renderChatList();
  }

  function newChat() {
    state.chatId = null; state.pending = []; renderChips();
    $('#chat-title').textContent = 'محادثة جديدة';
    resetWelcome(); renderChatList();
  }

  // ---------- المرفقات ----------
  function renderChips() {
    const box = $('#attach-chips'); box.textContent = '';
    state.pending.forEach((p, i) => {
      const c = document.createElement('span'); c.className = 'chip' + (p.uploading ? ' up' : '');
      c.append((p.kind === 'image' ? '🖼️ ' : '📎 ') + p.name + (p.uploading ? ' …' : ' '));
      if (!p.uploading) { const x = document.createElement('button'); x.type = 'button'; x.textContent = '✕'; x.setAttribute('aria-label', 'إزالة'); x.addEventListener('click', () => { state.pending.splice(i, 1); renderChips(); }); c.appendChild(x); }
      box.appendChild(c);
    });
  }

  async function handleFile(file) {
    if (!file) return;
    if (state.pending.length >= 5) return alert('أقصى عدد مرفقات 5');
    const item = { name: file.name, uploading: true };
    state.pending.push(item); renderChips();
    try {
      const fd = new FormData(); fd.append('file', file);
      const r = await api('/upload', { method: 'POST', body: fd });
      Object.assign(item, { id: r.id, kind: r.kind, name: r.name, uploading: false });
    } catch (e) {
      state.pending.splice(state.pending.indexOf(item), 1);
      alert(e.message);
    }
    renderChips();
  }

  // ---------- الإرسال ----------
  async function send(text) {
    text = text.trim();
    if (!text || state.busy || state.pending.some((p) => p.uploading)) return;
    state.busy = true; $('#btn-send').disabled = true;
    const atts = state.pending.filter((p) => p.id);
    addMessage('user', text, { attachments: atts });
    $('#input').value = ''; autosize();
    const ids = atts.map((a) => a.id);
    state.pending = []; renderChips();

    const bubble = addMessage('assistant', '');
    const status = document.createElement('div');
    status.className = 'status';
    status.innerHTML = '<span class="dots"><span></span><span></span><span></span></span><span class="st">بفكّر…</span>';
    bubble.appendChild(status);
    const fileBox = document.createElement('div');
    bubble.appendChild(fileBox);

    try {
      const r = await fetch('/api/chat', {
        method: 'POST', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: text, chatId: state.chatId, attachmentIds: ids }),
      });
      if (!r.ok) { const d = await r.json().catch(() => ({})); throw new Error(d.error || 'حصل خطأ'); }
      const reader = r.body.getReader(); const dec = new TextDecoder(); let buf = '';
      let failed = false;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let idx;
        while ((idx = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, idx); buf = buf.slice(idx + 2);
          const ev = /^event: (.+)$/m.exec(block)?.[1]; const dataLine = /^data: (.+)$/m.exec(block)?.[1];
          if (!ev || !dataLine) continue;
          const d = JSON.parse(dataLine);
          if (ev === 'chat') { state.chatId = d.chatId; $('#chat-title').textContent = d.title; }
          else if (ev === 'status') status.querySelector('.st').textContent = d.text;
          else if (ev === 'file') fileBox.appendChild(fileCard(d));
          else if (ev === 'text') { status.remove(); bubble.insertBefore(renderMd(d.content), fileBox); }
          else if (ev === 'done') { state.user.usedToday = d.usedToday; renderUser(); }
          else if (ev === 'error') { failed = true; status.remove(); const e = document.createElement('div'); e.className = 'error'; e.textContent = d.message; bubble.insertBefore(e, fileBox); }
          scrollDown();
        }
      }
      if (!failed) await loadChats(); else loadChats();
    } catch (e) {
      status.remove();
      const er = document.createElement('div'); er.className = 'error'; er.textContent = e.message; bubble.appendChild(er);
      api('/me').then((d) => { state.user = d.user; renderUser(); }).catch(() => {});
    } finally {
      state.busy = false; $('#btn-send').disabled = false; $('#input').focus(); scrollDown();
    }
  }

  // ---------- الذاكرة ----------
  async function openMemory() {
    const { memories } = await api('/memories');
    const ul = $('#mem-list'); ul.textContent = '';
    if (!memories.length) { const li = document.createElement('li'); li.textContent = 'لسه مفيش حاجة محفوظة.'; ul.appendChild(li); }
    for (const m of memories) {
      const li = document.createElement('li'); const s = document.createElement('span'); s.textContent = m.text;
      const b = document.createElement('button'); b.type = 'button'; b.textContent = '🗑'; b.setAttribute('aria-label', 'حذف');
      b.addEventListener('click', async () => { await api('/memories/' + m.id, { method: 'DELETE' }); li.remove(); });
      li.append(s, b); ul.appendChild(li);
    }
    $('#memory-modal').classList.remove('hidden');
  }

  // ---------- الدخول ----------
  function setMode(mode) {
    state.mode = mode;
    $('#tab-login').classList.toggle('active', mode === 'login');
    $('#tab-register').classList.toggle('active', mode === 'register');
    $('#f-name').classList.toggle('hidden', mode !== 'register');
    $('#auth-submit').textContent = mode === 'login' ? 'دخول' : 'إنشاء حساب';
    $('#f-pass').autocomplete = mode === 'login' ? 'current-password' : 'new-password';
    $('#auth-error').classList.add('hidden');
  }

  async function enterApp(user) {
    state.user = user;
    $('#auth').classList.add('hidden'); $('#app').classList.remove('hidden');
    renderUser(); await loadChats(); newChat();
  }

  // ---------- واجهة ----------
  function autosize() { const t = $('#input'); t.style.height = 'auto'; t.style.height = Math.min(t.scrollHeight, 200) + 'px'; }
  const openSide = () => { $('#sidebar').classList.add('open'); $('#scrim').classList.remove('hidden'); };
  const closeSide = () => { $('#sidebar').classList.remove('open'); $('#scrim').classList.add('hidden'); };

  const welcomeEl = $('#welcome');

  $('#tab-login').addEventListener('click', () => setMode('login'));
  $('#tab-register').addEventListener('click', () => setMode('register'));
  $('#auth-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = $('#auth-submit'); btn.disabled = true;
    try {
      const body = { email: $('#f-email').value, password: $('#f-pass').value };
      if (state.mode === 'register') body.name = $('#f-name').value;
      const { user } = await api('/auth/' + state.mode, { method: 'POST', body });
      $('#f-pass').value = '';
      await enterApp(user);
    } catch (err) {
      const box = $('#auth-error'); box.textContent = err.message; box.classList.remove('hidden');
    } finally { btn.disabled = false; }
  });
  $('#btn-logout').addEventListener('click', async () => { await api('/auth/logout', { method: 'POST' }); location.reload(); });
  $('#btn-new').addEventListener('click', () => { newChat(); closeSide(); });
  $('#btn-open-side').addEventListener('click', openSide);
  $('#btn-close-side').addEventListener('click', closeSide);
  $('#scrim').addEventListener('click', closeSide);
  $('#btn-memory').addEventListener('click', openMemory);
  $('#mem-close').addEventListener('click', () => $('#memory-modal').classList.add('hidden'));
  $('#memory-modal').addEventListener('click', (e) => { if (e.target.id === 'memory-modal') e.target.classList.add('hidden'); });
  $('#btn-attach').addEventListener('click', () => $('#file-input').click());
  $('#file-input').addEventListener('change', (e) => { handleFile(e.target.files[0]); e.target.value = ''; });
  $('#composer').addEventListener('submit', (e) => { e.preventDefault(); send($('#input').value); });
  $('#input').addEventListener('input', autosize);
  $('#input').addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); send($('#input').value); } });
  $('#input').addEventListener('paste', (e) => { const f = [...(e.clipboardData?.files || [])][0]; if (f) { e.preventDefault(); handleFile(f); } });
  $('#messages').addEventListener('click', (e) => { const b = e.target.closest('.suggest button'); if (b) send(b.dataset.q); });

  // ---------- بداية ----------
  (async () => {
    try { const { user } = await api('/me'); await enterApp(user); }
    catch { $('#auth').classList.remove('hidden'); setMode('login'); }
  })();
})();
