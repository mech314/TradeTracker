import { setToken } from "./auth.js";
import { apiChangePassword } from "./api.js";

const hashParams = new URLSearchParams(window.location.hash.slice(1));
const accessToken = hashParams.get("access_token");
const type = hashParams.get("type");

if (accessToken && type === "recovery") {
  setToken(accessToken);
  window.history.replaceState(null, "", window.location.pathname);

  document.querySelector("#app").innerHTML = `
    <div class="min-h-screen flex items-center justify-center bg-surface p-4">
      <div class="w-full max-w-sm rounded-xl border border-slate-800 bg-surface-raised p-6 space-y-4">
        <h1 class="text-xl font-semibold text-white">Set new password</h1>
        <p id="reset-msg" class="hidden text-sm"></p>
        <input type="password" id="reset-password" placeholder="New password"
          class="w-full rounded-lg bg-surface border border-slate-700 px-3 py-2 text-sm text-slate-200 focus:outline-none focus:ring-1 focus:ring-accent" />
        <input type="password" id="reset-confirm" placeholder="Confirm password"
          class="w-full rounded-lg bg-surface border border-slate-700 px-3 py-2 text-sm text-slate-200 focus:outline-none focus:ring-1 focus:ring-accent" />
        <button id="reset-submit"
          class="w-full py-2 rounded-lg bg-accent text-white text-sm font-medium hover:bg-blue-500 transition-colors">
          Update password
        </button>
      </div>
    </div>
  `;

  document.querySelector("#reset-submit").addEventListener("click", async () => {
    const pwd = document.querySelector("#reset-password").value;
    const confirm = document.querySelector("#reset-confirm").value;
    const msg = document.querySelector("#reset-msg");
    if (pwd !== confirm) {
      msg.textContent = "Passwords do not match";
      msg.className = "text-sm text-loss";
      msg.classList.remove("hidden");
      return;
    }
    try {
      await apiChangePassword(pwd);
      msg.textContent = "Password updated! Redirecting...";
      msg.className = "text-sm text-gain";
      msg.classList.remove("hidden");
      setTimeout(() => window.location.href = "/", 1500);
    } catch (e) {
      msg.textContent = e.message;
      msg.className = "text-sm text-loss";
      msg.classList.remove("hidden");
    }
  });
}