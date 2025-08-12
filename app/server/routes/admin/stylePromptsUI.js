import express from 'express';

const router = express.Router();

router.get('/admin/style-prompts-ui', async (req, res, next) => {
  try {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end(`<!doctype html>
<html lang="en">
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>Style Prompt Library</title>
<style>
  body{margin:0;background:#0b0d11;color:#e7ecf3;font:14px/1.4 ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto}
  .wrap{max-width:720px;margin:20px auto;padding:0 16px}
  h1{font-size:20px;margin:12px 0}
  table{width:100%;border-collapse:collapse}
  th, td{padding:8px;border-bottom:1px solid #283044}
  input, button{padding:6px 8px;border-radius:6px;border:1px solid #283044;background:#0f1320;color:#e7ecf3}
  button{cursor:pointer;background:#6aa4ff;color:#fff;border:none}
  button.delete{background:#ef4444}
  button.toggle{background:#f59e0b}
  .row{display:flex;gap:8px;margin:8px 0}
</style>
<div class="wrap">
  <h1>Style Prompt Library</h1>
  <div class="row">
    <input id="newPrompt" placeholder="New prompt text" style="flex:1" />
    <button id="addBtn">Add Prompt</button>
  </div>
  <table>
    <thead>
      <tr><th>Prompt</th><th>Enabled</th><th>Actions</th></tr>
    </thead>
    <tbody id="promptTable"></tbody>
  </table>
</div>
<script>
async function json(url, opts={}){ const r = await fetch(url, opts); if(!r.ok) throw new Error(await r.text()); return r.json(); }
const tableBody = document.getElementById('promptTable');
async function load(){
  const prompts = await json('/admin/style-prompts');
  tableBody.innerHTML = '';
  for(const p of prompts){
    const tr = document.createElement('tr');
    tr.innerHTML = \`
      <td>\${p.text}</td>
      <td>\${p.enabled}</td>
      <td>
        <button class="toggle" data-id="\${p.id}" data-enabled="\${p.enabled}">\${p.enabled ? 'Disable' : 'Enable'}</button>
        <button class="delete" data-id="\${p.id}">Delete</button>
      </td>\`;
    tableBody.appendChild(tr);
  }
}
document.getElementById('addBtn').addEventListener('click', async ()=>{
  const text = document.getElementById('newPrompt').value.trim();
  if(!text) return alert('Enter a prompt');
  await fetch('/admin/style-prompts', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }) });
  document.getElementById('newPrompt').value='';
  load();
});
tableBody.addEventListener('click', async (ev)=>{
  const btn = ev.target.closest('button');
  if(!btn) return;
  const id = btn.getAttribute('data-id');
  if(btn.classList.contains('delete')){
    await fetch('/admin/style-prompts/' + id, { method: 'DELETE' });
  }else if(btn.classList.contains('toggle')){
    const enabled = btn.getAttribute('data-enabled') === 'true';
    await fetch('/admin/style-prompts/' + id + '/toggle', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: !enabled }) });
  }
  load();
});
load();
</script>
</html>`);
  } catch (err) {
    next(err);
  }
});

export default router;
