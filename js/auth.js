import { TripStore } from './db.js';
import { ESIClient } from './esi.js';

const redirectToLocalhost = window.location.hostname === '127.0.0.1';
if (redirectToLocalhost) {
  window.location.replace(`http://localhost:59832${window.location.pathname}${window.location.search}${window.location.hash}`);
}

async function authorize() {
  const title = document.getElementById('auth-title');
  const message = document.getElementById('auth-message');
  const returnLink = document.getElementById('auth-return');
  const spinner = document.querySelector('.auth-spinner');
  try {
    const store = new TripStore();
    const esi = new ESIClient(store);
    const character = await esi.handleAuthorizationCallback();
    title.textContent = 'Character connected';
    message.textContent = `${character.name} is ready to plan routes.`;
    window.location.replace(`./?authorized=${encodeURIComponent(character.name)}`);
  } catch (error) {
    console.error(error);
    title.textContent = 'Connection failed';
    message.textContent = error?.message || 'EVE SSO could not be completed.';
    spinner.hidden = true;
    returnLink.hidden = false;
  }
}

if (!redirectToLocalhost) authorize();
