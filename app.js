"use strict";

const TSV_URL =
  "https://docs.google.com/spreadsheets/d/e/2PACX-1vROWLK8yc534HakCXX7LKb-Qqo1M29TfBU84B0BMnaC0r0sirlqmlIpAOc5rxic6M_TX8nfiui_Zriz/pub?gid=0&single=true&output=tsv";

const CACHE_KEY = "lpa:catalogo:v1";
const PAGE_SIZE = 24;
const FETCH_TIMEOUT_MS = 15000;
const SEARCH_DEBOUNCE_MS = 200;
const VALID_SORTS = ["novedades", "titulo-asc", "autor-asc", "anio-desc", "anio-asc"];

const FALLBACK_COVER_SVG =
  "data:image/svg+xml;charset=UTF-8," +
  encodeURIComponent(`
    <svg xmlns="http://www.w3.org/2000/svg" width="400" height="560" viewBox="0 0 400 560">
      <rect width="400" height="560" fill="#ebe4d8"/>
      <rect x="28" y="28" width="344" height="504" rx="14" fill="#fffdf9" stroke="#cfc4b2" stroke-width="2"/>
      <text x="200" y="255" text-anchor="middle" font-family="Georgia, serif" font-size="24" fill="#1b4332" font-weight="bold">La Página Abierta</text>
      <text x="200" y="292" text-anchor="middle" font-family="sans-serif" font-size="15" fill="#5b6860">Sin portada disponible</text>
    </svg>
  `);

const collator = new Intl.Collator("es", { sensitivity: "base" });

const state = {
  allBooks: [],
  currentList: [],
  rendered: 0,
  visibleCount: PAGE_SIZE,
  filters: {
    search: "",
    searchNorm: "",
    category: "",
    decade: "",
    author: "",
    sort: "novedades"
  }
};

const els = {
  siteHeader: document.getElementById("siteHeader"),
  filtersSlot: document.getElementById("filtersSlot"),
  brandReset: document.getElementById("brandReset"),
  toggleFiltersBtn: document.getElementById("toggleFiltersBtn"),
  activeFilterBadge: document.getElementById("activeFilterBadge"),
  filtersPanel: document.getElementById("filtersPanel"),
  searchInput: document.getElementById("searchInput"),
  categoryFilter: document.getElementById("categoryFilter"),
  decadeFilter: document.getElementById("decadeFilter"),
  authorFilter: document.getElementById("authorFilter"),
  sortFilter: document.getElementById("sortFilter"),
  clearFiltersBtn: document.getElementById("clearFiltersBtn"),
  emptyResetBtn: document.getElementById("emptyResetBtn"),
  resultsCounter: document.getElementById("resultsCounter"),
  statusMessage: document.getElementById("statusMessage"),
  booksGrid: document.getElementById("booksGrid"),
  emptyState: document.getElementById("emptyState"),
  loadMoreWrap: document.getElementById("loadMoreWrap"),
  loadMoreBtn: document.getElementById("loadMoreBtn"),
  totalBooksFooter: document.getElementById("totalBooksFooter")
};

/* ---------- Utilidades ---------- */

function createEl(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function normalizeText(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();
}

function parseYear(rawYear) {
  const match = String(rawYear || "").match(/\d{4}/);
  return match ? Number(match[0]) : null;
}

function getDecadeInfo(year) {
  if (typeof year !== "number" || Number.isNaN(year)) return null;
  const start = Math.floor(year / 10) * 10;
  return {
    key: `${start}-${start + 9}`,
    label: `${start}–${start + 9}`,
    start
  };
}

// Solo se aceptan enlaces http(s): evita "javascript:" u otros esquemas que vengan de la hoja.
function safeUrl(raw) {
  if (!raw) return "";
  try {
    const url = new URL(raw, window.location.href);
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : "";
  } catch {
    return "";
  }
}

/* ---------- Lectura del TSV ---------- */

// Parser TSV que respeta celdas entre comillas (con saltos de línea, tabs y comillas dobles escapadas).
function parseTSVRows(text) {
  const rows = [];
  let row = [];
  let cell = "";
  let inQuotes = false;

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];

    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        cell += ch;
      }
    } else if (ch === '"' && cell === "") {
      inQuotes = true;
    } else if (ch === "\t") {
      row.push(cell);
      cell = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i += 1;
      row.push(cell);
      cell = "";
      rows.push(row);
      row = [];
    } else {
      cell += ch;
    }
  }

  if (cell !== "" || row.length) {
    row.push(cell);
    rows.push(row);
  }

  return rows;
}

function parseBooks(tsvText) {
  if (/^\s*<(!doctype|html)/i.test(tsvText)) {
    throw new Error("La respuesta no es un TSV (¿la hoja dejó de estar publicada?)");
  }

  const rows = parseTSVRows(tsvText.replace(/^\uFEFF/, ""));
  if (rows.length <= 1) return [];

  const books = [];

  rows.slice(1).forEach((cols, index) => {
    const get = (i) => (cols[i] || "").trim();

    const title = get(0);
    const author = get(1);
    const rawYear = get(2);
    const category = get(3);
    const description = get(4);
    const link = safeUrl(get(5));
    const cover = safeUrl(get(6));
    const pass = get(7);

    if (!title && !author && !description && !link) return;

    const yearNum = parseYear(rawYear);
    const decadeInfo = getDecadeInfo(yearNum);

    const book = {
      sheetOrder: index,
      title: title || "Sin título",
      author: author || "Autor desconocido",
      yearLabel: rawYear || (yearNum ? String(yearNum) : ""),
      yearNum,
      decadeKey: decadeInfo ? decadeInfo.key : "",
      decadeLabel: decadeInfo ? decadeInfo.label : "",
      decadeStart: decadeInfo ? decadeInfo.start : null,
      category: category || "Sin categoría",
      description: description || "Sin descripción disponible.",
      link,
      cover,
      pass
    };

    // Texto de búsqueda precalculado: evita normalizar todo el catálogo en cada pulsación.
    book.searchText = normalizeText(
      `${book.title} ${book.author} ${book.description} ${book.category} ${book.yearLabel}`
    );

    books.push(book);
  });

  return books;
}

/* ---------- Filtros y orden ---------- */

function matchesBook(book, f, ignoreField = null) {
  if (ignoreField !== "category" && f.category && book.category !== f.category) return false;
  if (ignoreField !== "decade" && f.decade && book.decadeKey !== f.decade) return false;
  if (ignoreField !== "author" && f.author && book.author !== f.author) return false;
  if (ignoreField !== "search" && f.searchNorm && !book.searchText.includes(f.searchNorm)) {
    return false;
  }
  return true;
}

// Los libros sin año siempre quedan al final.
function compareYear(a, b, direction) {
  if (a.yearNum === null && b.yearNum === null) return 0;
  if (a.yearNum === null) return 1;
  if (b.yearNum === null) return -1;
  return direction * (a.yearNum - b.yearNum);
}

function getFilteredAndSortedBooks() {
  const filtered = state.allBooks.filter((book) => matchesBook(book, state.filters));

  return filtered.sort((a, b) => {
    const newestFirst = b.sheetOrder - a.sheetOrder;
    switch (state.filters.sort) {
      case "titulo-asc":
        return collator.compare(a.title, b.title) || newestFirst;
      case "autor-asc":
        return collator.compare(a.author, b.author) || newestFirst;
      case "anio-desc":
        return compareYear(a, b, -1) || newestFirst;
      case "anio-asc":
        return compareYear(a, b, 1) || newestFirst;
      case "novedades":
      default:
        return newestFirst;
    }
  });
}

function populateSelectOptions(selectEl, options, currentValue, defaultLabel) {
  const fragment = document.createDocumentFragment();

  const defaultOpt = document.createElement("option");
  defaultOpt.value = "";
  defaultOpt.textContent = defaultLabel;
  fragment.appendChild(defaultOpt);

  options.forEach((opt) => {
    const optionEl = document.createElement("option");
    optionEl.value = opt.value;
    optionEl.textContent = opt.label;
    fragment.appendChild(optionEl);
  });

  selectEl.replaceChildren(fragment);
  selectEl.value = currentValue && options.some((o) => o.value === currentValue) ? currentValue : "";
}

// Filtros en cascada: cada lista solo ofrece valores que existen con los demás filtros activos.
function updateDynamicFilterOptions() {
  const specs = [
    {
      field: "category",
      el: els.categoryFilter,
      label: "Todas las categorías",
      pick: (b) => ({ value: b.category, label: b.category }),
      sort: (a, b) => collator.compare(a.label, b.label)
    },
    {
      field: "decade",
      el: els.decadeFilter,
      label: "Todos los años",
      pick: (b) => (b.decadeKey ? { value: b.decadeKey, label: b.decadeLabel, start: b.decadeStart } : null),
      sort: (a, b) => b.start - a.start
    },
    {
      field: "author",
      el: els.authorFilter,
      label: "Todos los autores",
      pick: (b) => ({ value: b.author, label: b.author }),
      sort: (a, b) => collator.compare(a.label, b.label)
    }
  ];

  specs.forEach((spec) => {
    const map = new Map();
    state.allBooks.forEach((book) => {
      if (!matchesBook(book, state.filters, spec.field)) return;
      const option = spec.pick(book);
      if (option && !map.has(option.value)) map.set(option.value, option);
    });

    if (state.filters[spec.field] && !map.has(state.filters[spec.field])) {
      state.filters[spec.field] = "";
    }

    populateSelectOptions(
      spec.el,
      [...map.values()].sort(spec.sort),
      state.filters[spec.field],
      spec.label
    );
  });
}

function updateFilterBadge() {
  const f = state.filters;
  const activeCount =
    (f.search.trim() ? 1 : 0) +
    (f.category ? 1 : 0) +
    (f.decade ? 1 : 0) +
    (f.author ? 1 : 0) +
    (f.sort !== "novedades" ? 1 : 0);

  els.activeFilterBadge.textContent = String(activeCount);
  els.activeFilterBadge.hidden = activeCount === 0;
}

/* ---------- Filtros en la URL (para compartir búsquedas) ---------- */

function applyFiltersFromURL() {
  try {
    const params = new URLSearchParams(window.location.search);
    const search = params.get("q") || "";
    const sort = params.get("orden");

    state.filters.search = search;
    state.filters.searchNorm = normalizeText(search);
    state.filters.category = params.get("categoria") || "";
    state.filters.decade = params.get("decada") || "";
    state.filters.author = params.get("autor") || "";
    state.filters.sort = VALID_SORTS.includes(sort) ? sort : "novedades";

    els.searchInput.value = search;
    els.sortFilter.value = state.filters.sort;
  } catch {
    /* sin soporte de URLSearchParams: se ignora */
  }
}

function syncURL() {
  const f = state.filters;
  const params = new URLSearchParams();
  if (f.search.trim()) params.set("q", f.search.trim());
  if (f.category) params.set("categoria", f.category);
  if (f.decade) params.set("decada", f.decade);
  if (f.author) params.set("autor", f.author);
  if (f.sort !== "novedades") params.set("orden", f.sort);

  const qs = params.toString();
  try {
    window.history.replaceState(null, "", qs ? `${window.location.pathname}?${qs}` : window.location.pathname);
  } catch {
    /* algunos entornos (p. ej. file://) no permiten replaceState */
  }
}

/* ---------- Tarjetas ---------- */

function createBookCard(book) {
  const scene = createEl("div", "book-card-scene");
  const card = createEl("article", "book-card");
  const cardLabel = `Ver ficha de ${book.title}`;

  /* Frente: categoría, año, título, autor y portada */
  const front = createEl("div", "card-face card-front");

  const topMeta = createEl("div", "card-top-meta");
  topMeta.appendChild(createEl("span", "category-pill", book.category));
  if (book.yearLabel) topMeta.appendChild(createEl("span", "year-tag", book.yearLabel));

  const headerInfo = createEl("div", "card-header-info");
  headerInfo.appendChild(createEl("h3", "book-title", book.title));
  headerInfo.appendChild(createEl("p", "book-author", book.author));

  const coverFrame = createEl("div", "cover-frame");
  const coverImg = createEl("img", "cover-image");
  coverImg.src = book.cover || FALLBACK_COVER_SVG;
  coverImg.alt = `Portada de ${book.title}`;
  coverImg.width = 400;
  coverImg.height = 560;
  coverImg.loading = "lazy";
  coverImg.decoding = "async";
  coverImg.referrerPolicy = "no-referrer";
  coverImg.addEventListener(
    "error",
    () => {
      if (coverImg.src !== FALLBACK_COVER_SVG) coverImg.src = FALLBACK_COVER_SVG;
    },
    { once: true }
  );
  coverFrame.appendChild(coverImg);

  const hintEl = createEl("div", "flip-hint");
  hintEl.appendChild(createEl("span", null, "Toca para ver ficha"));
  const hintIcon = createEl("span", null, "↻");
  hintIcon.setAttribute("aria-hidden", "true");
  hintEl.appendChild(hintIcon);

  front.append(topMeta, headerInfo, coverFrame, hintEl);

  /* Reverso: ficha, descripción, pass y descarga */
  const back = createEl("div", "card-face card-back");

  const backHeader = createEl("div", "back-header");
  const backTopRow = createEl("div", "back-top-row");
  backTopRow.appendChild(createEl("span", "category-pill", book.category));

  const flipBackBtn = createEl("button", "flip-back-btn", "Volver");
  flipBackBtn.type = "button";
  backTopRow.appendChild(flipBackBtn);

  backHeader.append(
    backTopRow,
    createEl("h3", "back-title", book.title),
    createEl(
      "p",
      "back-author-year",
      book.yearLabel ? `${book.author} · ${book.yearLabel}` : book.author
    )
  );

  const descScroll = createEl("div", "back-description-scroll");
  descScroll.appendChild(createEl("p", "back-description", book.description));

  const backFooter = createEl("div", "back-footer");

  if (book.pass) {
    const passArea = createEl("div", "pass-area");

    const passBtn = createEl("button", "btn-pass", "Ver pass");
    passBtn.type = "button";
    passBtn.setAttribute("aria-expanded", "false");

    const passBox = createEl("div", "pass-value", `Pass: ${book.pass}`);
    passBox.hidden = true;

    passBtn.addEventListener("click", () => {
      const willShow = passBox.hidden;
      passBox.hidden = !willShow;
      passBtn.textContent = willShow ? "Ocultar pass" : "Ver pass";
      passBtn.setAttribute("aria-expanded", String(willShow));
    });

    passArea.append(passBtn, passBox);
    backFooter.appendChild(passArea);
  }

  if (book.link) {
    const downloadLink = createEl("a", "download-btn", "DESCARGA");
    downloadLink.href = book.link;
    downloadLink.target = "_blank";
    downloadLink.rel = "noopener noreferrer";
    downloadLink.appendChild(createEl("span", "sr-only", ` de ${book.title} (se abre en una pestaña nueva)`));
    backFooter.appendChild(downloadLink);
  } else {
    backFooter.appendChild(createEl("p", "link-notice", "Enlace no disponible"));
  }

  back.append(backHeader, descScroll, backFooter);
  card.append(front, back);
  scene.appendChild(card);

  /* Giro: la cara oculta queda "inert" para que el teclado y los lectores de pantalla no lleguen a ella */
  const setFlipped = (flipped, moveFocus = true) => {
    card.classList.toggle("is-flipped", flipped);
    front.inert = flipped;
    back.inert = !flipped;

    if (flipped) {
      card.removeAttribute("role");
      card.removeAttribute("aria-label");
      card.tabIndex = -1;
      if (moveFocus) flipBackBtn.focus({ preventScroll: true });
    } else {
      card.setAttribute("role", "button");
      card.setAttribute("aria-label", cardLabel);
      card.tabIndex = 0;
      if (moveFocus) card.focus({ preventScroll: true });
    }
  };

  setFlipped(false, false);

  card.addEventListener("click", (e) => {
    if (e.target.closest("a, button, .back-description-scroll")) return;
    setFlipped(!card.classList.contains("is-flipped"));
  });

  flipBackBtn.addEventListener("click", () => setFlipped(false));

  card.addEventListener("keydown", (e) => {
    const flipped = card.classList.contains("is-flipped");
    if ((e.key === "Enter" || e.key === " ") && e.target === card && !flipped) {
      e.preventDefault();
      setFlipped(true);
    } else if (e.key === "Escape" && flipped) {
      setFlipped(false);
    }
  });

  return scene;
}

/* ---------- Render ---------- */

function renderCatalog(append = false) {
  const list = append ? state.currentList : getFilteredAndSortedBooks();
  const totalCount = state.allBooks.length;

  state.currentList = list;
  els.totalBooksFooter.textContent = `Libros disponibles: ${totalCount}`;
  els.resultsCounter.textContent = `Mostrando ${list.length} de ${totalCount} libros`;

  if (list.length === 0) {
    els.booksGrid.replaceChildren();
    els.booksGrid.hidden = true;
    els.loadMoreWrap.hidden = true;
    els.emptyState.hidden = false;
    state.rendered = 0;
    return;
  }

  els.emptyState.hidden = true;
  els.booksGrid.hidden = false;

  const from = append ? state.rendered : 0;
  const to = Math.min(state.visibleCount, list.length);

  if (!append) els.booksGrid.replaceChildren();

  const fragment = document.createDocumentFragment();
  for (let i = from; i < to; i += 1) {
    fragment.appendChild(createBookCard(list[i]));
  }
  els.booksGrid.appendChild(fragment);
  state.rendered = to;

  const remaining = list.length - to;
  els.loadMoreWrap.hidden = remaining <= 0;
  if (remaining > 0) {
    els.loadMoreBtn.textContent = `Mostrar más libros (${remaining} restantes)`;
  }
}

// Punto único de actualización cuando cambia cualquier filtro.
function refresh() {
  state.visibleCount = PAGE_SIZE;
  updateDynamicFilterOptions();
  updateFilterBadge();
  syncURL();
  renderCatalog(false);
}

let searchTimer = null;

function resetAllFilters() {
  clearTimeout(searchTimer);

  state.filters.search = "";
  state.filters.searchNorm = "";
  state.filters.category = "";
  state.filters.decade = "";
  state.filters.author = "";
  state.filters.sort = "novedades";

  els.searchInput.value = "";
  els.sortFilter.value = "novedades";

  refresh();
}

/* ---------- Eventos ---------- */

/* ---------- Menú de filtros (hamburguesa) ---------- */

// Escritorio: los filtros se ven arriba de todo y se van con el scroll; al quedar fuera de pantalla
// aparece el botón hamburguesa y el panel se abre encima del contenido, sin empujarlo.
// Móvil: el panel siempre se abre desde el botón.
function initFiltersMenu() {
  const desktopMQ = window.matchMedia("(min-width: 860px)");
  const panel = els.filtersPanel;
  let observer = null;
  let resizeTimer = null;

  const isOpen = () => panel.classList.contains("is-open");

  const setOpen = (open) => {
    if (open === isOpen()) return;

    if (open) {
      // En escritorio el panel sale del flujo: se reserva su altura para que el contenido no salte.
      if (desktopMQ.matches) els.filtersSlot.style.minHeight = `${panel.offsetHeight}px`;
      panel.classList.add("is-open");
    } else {
      panel.classList.remove("is-open");
      els.filtersSlot.style.minHeight = "";
    }
    els.toggleFiltersBtn.setAttribute("aria-expanded", String(open));
  };

  const observeSlot = () => {
    const barHeight = els.siteHeader.offsetHeight;
    document.documentElement.style.setProperty("--bar-h", `${barHeight}px`);

    if (!("IntersectionObserver" in window)) return;
    if (observer) observer.disconnect();

    observer = new IntersectionObserver(
      ([entry]) => {
        const offscreen = !entry.isIntersecting;
        document.body.classList.toggle("filters-offscreen", offscreen);
        // Si el usuario vuelve arriba, el panel regresa a su lugar en la página.
        if (!offscreen && desktopMQ.matches) setOpen(false);
      },
      { rootMargin: `-${barHeight}px 0px 0px 0px` }
    );
    observer.observe(els.filtersSlot);
  };

  els.toggleFiltersBtn.addEventListener("click", () => setOpen(!isOpen()));

  document.addEventListener("click", (e) => {
    if (isOpen() && !e.target.closest("#filtersPanel, #toggleFiltersBtn")) setOpen(false);
  });

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && isOpen()) {
      setOpen(false);
      els.toggleFiltersBtn.focus();
    }
  });

  desktopMQ.addEventListener("change", () => {
    setOpen(false);
    observeSlot();
  });

  window.addEventListener("resize", () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(observeSlot, 150);
  });

  window.addEventListener("load", observeSlot);
  observeSlot();
}

function bindEvents() {
  initFiltersMenu();

  els.searchInput.addEventListener("input", (e) => {
    const value = e.target.value;
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      state.filters.search = value;
      state.filters.searchNorm = normalizeText(value);
      refresh();
    }, SEARCH_DEBOUNCE_MS);
  });

  [
    [els.categoryFilter, "category"],
    [els.decadeFilter, "decade"],
    [els.authorFilter, "author"],
    [els.sortFilter, "sort"]
  ].forEach(([select, field]) => {
    select.addEventListener("change", (e) => {
      state.filters[field] = e.target.value;
      refresh();
    });
  });

  els.clearFiltersBtn.addEventListener("click", resetAllFilters);
  els.emptyResetBtn.addEventListener("click", resetAllFilters);

  els.loadMoreBtn.addEventListener("click", () => {
    const before = state.rendered;
    state.visibleCount += PAGE_SIZE;
    renderCatalog(true);

    // Si el botón desaparece, el foco pasa a la primera tarjeta nueva en lugar de perderse.
    if (els.loadMoreWrap.hidden) {
      const firstNew = els.booksGrid.children[before];
      if (firstNew) firstNew.querySelector(".book-card")?.focus({ preventScroll: true });
    }
  });

  els.brandReset.addEventListener("click", (e) => {
    e.preventDefault();
    resetAllFilters();
    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    window.scrollTo({ top: 0, behavior: reduceMotion ? "auto" : "smooth" });
  });
}

/* ---------- Carga de datos (caché local + actualización en segundo plano) ---------- */

function readCache() {
  try {
    return window.localStorage.getItem(CACHE_KEY);
  } catch {
    return null;
  }
}

function writeCache(text) {
  try {
    window.localStorage.setItem(CACHE_KEY, text);
  } catch {
    /* almacenamiento lleno o bloqueado: se ignora */
  }
}

async function fetchCatalogText() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(TSV_URL, { cache: "no-store", signal: controller.signal });
    if (!response.ok) throw new Error(`Error de red: ${response.status}`);
    return await response.text();
  } finally {
    clearTimeout(timer);
  }
}

function showStatus(message) {
  els.statusMessage.hidden = false;
  els.statusMessage.textContent = message;
}

function showLoadError() {
  els.resultsCounter.textContent = "No se pudo cargar el catálogo";
  els.statusMessage.hidden = false;

  const retryBtn = createEl("button", "btn-primary", "Reintentar");
  retryBtn.type = "button";
  retryBtn.addEventListener("click", () => {
    showStatus("Cargando biblioteca desde Google Sheets...");
    els.resultsCounter.textContent = "Cargando catálogo...";
    loadCatalog();
  });

  els.statusMessage.replaceChildren(
    createEl(
      "p",
      null,
      "No se pudo cargar el catálogo en este momento. Revisa tu conexión e inténtalo de nuevo."
    ),
    retryBtn
  );
}

function showBooks(books) {
  state.allBooks = books;
  els.statusMessage.hidden = true;
  refresh();
}

async function loadCatalog() {
  const cached = readCache();

  // Con caché, el catálogo aparece al instante y se actualiza si la hoja cambió.
  if (cached) {
    try {
      showBooks(parseBooks(cached));
    } catch (error) {
      console.warn("Caché inválida, se descarga de nuevo:", error);
    }
  }

  try {
    const fresh = await fetchCatalogText();
    if (fresh !== cached || state.allBooks.length === 0) {
      const books = parseBooks(fresh);
      writeCache(fresh);
      showBooks(books);
    }
  } catch (error) {
    console.error("Error al cargar el catálogo:", error);
    if (state.allBooks.length === 0) showLoadError();
  }
}

function initCatalog() {
  bindEvents();
  applyFiltersFromURL();
  loadCatalog();
}

initCatalog();
