const byId = (id) => document.getElementById(id);
const scenario = document.body.dataset.scenario;

if (scenario === '1') byId('save-button').addEventListener('click', () => byId('save-state').textContent = 'Saved');
if (scenario === '3') {
  byId('account-menu-button').addEventListener('click', () => {
    const menu = byId('menu'); const open = menu.hidden;
    menu.hidden = !open; byId('account-menu-button').setAttribute('aria-expanded', String(open));
  });
  byId('admin-menu-item').addEventListener('click', () => byId('menu-state').textContent = 'Admin selected');
}
if (scenario === '4') byId('role-select').addEventListener('change', (event) => byId('role-state').textContent = `Role: ${event.target.value}`);
if (scenario === '5') {
  byId('edit-profile-button').addEventListener('click', () => byId('profile-dialog').showModal());
  byId('dialog-save').addEventListener('click', () => { byId('profile-dialog').close(); byId('profile-state').textContent = 'Profile saved'; });
}
if (scenario === '6') byId('load-continue').addEventListener('click', () => setTimeout(() => {
  const button = document.createElement('button'); button.id = 'continue-button'; button.textContent = 'Continue';
  button.addEventListener('click', () => byId('continue-state').textContent = 'Continued'); byId('dynamic-target').replaceChildren(button);
}, 80));
if (scenario === '7') byId('search-button').addEventListener('click', () => byId('search-state').textContent = 'Search selected');
if (scenario === '8') byId('unlabeled-menu-icon').addEventListener('click', () => byId('menu-icon-state').textContent = 'Menu opened');
if (scenario === '9') {
  byId('billing-edit').addEventListener('click', () => byId('edit-state').textContent = 'Billing edit selected');
  byId('shipping-edit').addEventListener('click', () => byId('edit-state').textContent = 'Shipping edit selected');
}
if (scenario === '11') {
  byId('priority-control').addEventListener('click', () => { const list = byId('priority-options'); list.hidden = !list.hidden; byId('priority-control').setAttribute('aria-expanded', String(!list.hidden)); });
  byId('priority-options').addEventListener('click', (event) => { if (event.target.getAttribute('role') === 'option') { byId('priority-value').textContent = event.target.textContent; byId('priority-options').hidden = true; byId('priority-control').setAttribute('aria-expanded', 'false'); } });
}
if (scenario === '12') {
  class PreferencesPanel extends HTMLElement {
    connectedCallback() {
      const root = this.attachShadow({ mode: 'open' });
      root.innerHTML = '<button id="preferences-apply">Apply</button><output aria-live="polite"></output>';
      root.querySelector('button').addEventListener('click', () => root.querySelector('output').textContent = 'Applied');
    }
  }
  customElements.define('preferences-panel', PreferencesPanel);
}
