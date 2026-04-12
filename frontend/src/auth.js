const API = ""; // same origin, empty string = relative URLs

export function getToken() {
    return localStorage.getItem('access_token')
}

export function setToken(token) {
    localStorage.setItem('access_token', token)
}

export function removeToken() {
    localStorage.removeItem('access_token')
}

export function isLoggedIn() {
    return !!getToken()
}

export async function login(email, password) {
    const res = await fetch(`${API}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
    });
    if (!res.ok) throw new Error('Invalid credentials');
    const data = await res.json();
    setToken(data.access_token);
    return data.user;
    }

export async function register(email, password) {
    const res = await fetch(`${API}/api/auth/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
    });
    if (!res.ok) throw new Error('Registration failed');
    return await res.json();
}

export function logout() {
    removeToken();
    window.location.reload();
}