const form = document.querySelector('#ticket-form');
const imageInput = document.querySelector('#image-input');
const uploadZone = document.querySelector('#upload-zone');
const preview = document.querySelector('#preview');
const uploadPrompt = document.querySelector('#upload-prompt');
const submitButton = document.querySelector('#submit-button');
const modal = document.querySelector('#result-modal');
const result = document.querySelector('#analysis-result');
const ticketList = document.querySelector('#ticket-list');
const imageModal = document.querySelector('#image-modal');
const fullImage = document.querySelector('#full-image');
const imageCaption = document.querySelector('#image-caption');
const escapeHtml = value => String(value || '').replace(/[&<>'"]/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#039;', '"': '&quot;' })[character]);

function showSection(id) {
  document.querySelectorAll('.section').forEach(section => section.classList.remove('active-section'));
  document.querySelector(id).classList.add('active-section');
  document.querySelectorAll('nav a').forEach(link => link.classList.toggle('active', link.getAttribute('href') === id));
  if (id === '#history') loadTickets();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

document.querySelectorAll('nav a').forEach(link => link.addEventListener('click', event => { event.preventDefault(); showSection(link.getAttribute('href')); }));
document.querySelector('#new-ticket').addEventListener('click', () => showSection('#submit'));
document.querySelector('#view-history').addEventListener('click', () => { modal.classList.add('hidden'); showSection('#history'); });
document.querySelector('#close-modal').addEventListener('click', () => modal.classList.add('hidden'));
document.querySelector('#close-image-modal').addEventListener('click', () => imageModal.classList.add('hidden'));
imageModal.addEventListener('click', event => { if (event.target === imageModal) imageModal.classList.add('hidden'); });

function previewFile(file) {
  if (!file) return;
  preview.src = URL.createObjectURL(file);
  preview.classList.add('visible');
  uploadPrompt.classList.add('hidden');
  uploadZone.classList.add('has-file');
}
imageInput.addEventListener('change', () => previewFile(imageInput.files[0]));
uploadZone.addEventListener('dragover', event => { event.preventDefault(); uploadZone.classList.add('dragging'); });
uploadZone.addEventListener('dragleave', () => uploadZone.classList.remove('dragging'));
uploadZone.addEventListener('drop', event => { event.preventDefault(); uploadZone.classList.remove('dragging'); const file = event.dataTransfer.files[0]; if (file && file.type.startsWith('image/')) { const dt = new DataTransfer(); dt.items.add(file); imageInput.files = dt.files; previewFile(file); } });

form.addEventListener('submit', async event => {
  event.preventDefault();
  const original = submitButton.innerHTML;
  submitButton.disabled = true;
  submitButton.innerHTML = '<span class="spinner"></span> Reviewing your photo…';
  try {
    const response = await fetch('/api/tickets', { method: 'POST', body: new FormData(form) });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Could not create this ticket.');
    const ticket = data.ticket;
    const sourceNote = data.analysisSource === 'fallback' ? '<p class="model-note">Ollama is unavailable, so we used the details you provided to choose a vendor.</p>' : '';
    result.innerHTML = `<div class="analysis-box"><p class="category-tag">${ticket.category}</p><h3>${ticket.diagnosis}</h3><div class="vendor-row"><span class="vendor-initials">${ticket.vendor.initials}</span><div><strong>${ticket.vendor.name}</strong><span>${ticket.vendor.specialty}</span></div><span class="urgency ${ticket.urgency.toLowerCase()}">${ticket.urgency} priority</span></div></div>${sourceNote}`;
    modal.classList.remove('hidden');
    form.reset(); preview.classList.remove('visible'); uploadPrompt.classList.remove('hidden'); uploadZone.classList.remove('has-file');
  } catch (error) { alert(error.message); }
  finally { submitButton.disabled = false; submitButton.innerHTML = original; }
});

async function loadTickets() {
  try {
    const response = await fetch('/api/tickets');
    const tickets = await response.json();
    if (!tickets.length) { ticketList.innerHTML = '<div class="empty-state"><span>⌁</span><h3>No requests yet</h3><p>New maintenance requests will appear here.</p></div>'; return; }
    ticketList.innerHTML = tickets.map(ticket => {
      const photo = ticket.imageUrl ? `<button class="ticket-thumbnail" type="button" data-image="${escapeHtml(ticket.imageUrl)}" data-caption="${escapeHtml(ticket.id)} · ${escapeHtml(ticket.location)}"><img src="${escapeHtml(ticket.imageUrl)}" alt="Issue photo for ${escapeHtml(ticket.id)}" /></button>` : '<div class="ticket-thumbnail no-image">No photo</div>';
      return `<article class="ticket-card">${photo}<div class="ticket-id">${escapeHtml(ticket.id)}<span>${new Date(ticket.createdAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}</span></div><div class="ticket-main"><span class="category-tag">${escapeHtml(ticket.category)}</span><h3>${escapeHtml(ticket.diagnosis)}</h3><p>${escapeHtml(ticket.location)} · ${escapeHtml(ticket.residentName)}</p></div><div class="assigned"><span>Assigned to</span><strong>${escapeHtml(ticket.vendor.name)}</strong><small>${escapeHtml(ticket.vendor.specialty)}</small></div><span class="urgency ${escapeHtml(ticket.urgency.toLowerCase())}">${escapeHtml(ticket.urgency)}</span></article>`;
    }).join('');
  } catch { ticketList.innerHTML = '<div class="empty-state">Could not load ticket history.</div>'; }
}

ticketList.addEventListener('click', event => {
  const thumbnail = event.target.closest('.ticket-thumbnail:not(.no-image)');
  if (!thumbnail) return;
  fullImage.src = thumbnail.dataset.image;
  imageCaption.textContent = thumbnail.dataset.caption;
  imageModal.classList.remove('hidden');
});
