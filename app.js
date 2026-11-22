const TSV_URL =
  "https://docs.google.com/spreadsheets/d/e/2PACX-1vROWLK8yc534HakCXX7LKb-Qqo1M29TfBU84B0BMnaC0r0sirlqmlIpAOc5rxic6M_TX8nfiui_Zriz/pub?gid=0&single=true&output=tsv";

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

const state = {
  allBooks: [],
  filters: {
    search: "",
    category: "",
    decade: "",
    author: "",
    sort: "novedades"
  }
};

const els = {
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
  totalBooksFooter: document.getElementById("totalBooksFooter")
};

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
  if (typeof year !== "number" || Number.isNaN(year)) {
    return null;
  }
  const start = Math.floor(year / 10) * 10;
  const end = start + 9;
  return {
    key: `${start}-${end}`,
    label: `${start}–${end}`,
    start
  };
}

function parseTSV(tsvText) {
  const lines = tsvText
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .split("\n")
    .filter((line) => line.trim() !== "");

  if (lines.length <= 1) {
    return [];
  }

  const dataRows = lines.slice(1);
  const parsed = [];

  dataRows.forEach((line, index) => {
    const cols = line.split("\t").map((cell) => cell.trim());
    const title = cols[0] || "";
    const author = cols[1] || "";
    const rawYear = cols[2] || "";
    const category = cols[3] || "";
    const description = cols[4] || "";
    const link = cols[5] || "";
    const cover = cols[6] || "";
    const pass = cols[7] || "";

    if (!title && !author && !description && !link) {
      return;
    }

    const yearNum = parseYear(rawYear);
    const decadeInfo = getDecadeInfo(yearNum);

    parsed.push({
      id: index + 1,
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
    });
  });

  // Orden inverso por defecto: los últimos en la hoja aparecen primero (novedades)
  return parsed.reverse();
}

function matchesBook(book, activeFilters, ignoreField = null) {
  if (ignoreField !== "category" && activeFilters.category) {
    if (book.category !== activeFilters.category) return false;
  }

  if (ignoreField !== "decade" && activeFilters.decade) {
    if (book.decadeKey !== activeFilters.decade) return false;
  }

  if (ignoreField !== "author" && activeFilters.author) {
    if (book.author !== activeFilters.author) return false;
  }

  if (ignoreField !== "search" && activeFilters.search) {
    const q = normalizeText(activeFilters.search);
    const haystack = normalizeText(
      `${book.title} ${book.author} ${book.description} ${book.category} ${book.yearLabel}`
    );
    if (!haystack.includes(q)) return false;
  }

  return true;
}

function getFilteredAndSortedBooks() {
  const filtered = state.allBooks.filter((book) => matchesBook(book, state.filters));
  const sortMode = state.filters.sort;

  const sorted = [...filtered].sort((a, b) => {
    switch (sortMode) {
      case "titulo-asc":
        return a.title.localeCompare(b.title, "es", { sensitivity: "base" });
      case "autor-asc":
        return a.author.localeCompare(b.author, "es", { sensitivity: "base" });
      case "anio-desc": {
        if (a.yearNum === null && b.yearNum === null) return b.sheetOrder - a.sheetOrder;
        if (a.yearNum === null) return 1;
        if (b.yearNum === null) return -1;
        if (b.yearNum !== a.yearNum) return b.yearNum - a.yearNum;
        return b.sheetOrder - a.sheetOrder;
      }
      case "anio-asc": {
        if (a.yearNum === null && b.yearNum === null) return b.sheetOrder - a.sheetOrder;
        if (a.yearNum === null) return 1;
        if (b.yearNum === null) return -1;
        if (a.yearNum !== b.yearNum) return a.yearNum - b.yearNum;
        return b.sheetOrder - a.sheetOrder;
      }
      case "novedades":
      default:
        return b.sheetOrder - a.sheetOrder;
    }
  });

  return sorted;
}

function populateSelectOptions(selectEl, options, currentValue, defaultLabel) {
  selectEl.innerHTML = "";
  const defaultOpt = document.createElement("option");
  defaultOpt.value = "";
  defaultOpt.textContent = defaultLabel;
  selectEl.appendChild(defaultOpt);

  options.forEach((opt) => {
    const optionEl = document.createElement("option");
    optionEl.value = opt.value;
    optionEl.textContent = opt.label;
    selectEl.appendChild(optionEl);
  });

  if (currentValue && options.some((o) => o.value === currentValue)) {
    selectEl.value = currentValue;
  } else {
    selectEl.value = "";
  }
}

function updateDynamicFilterOptions() {
  const booksForCategory = state.allBooks.filter((b) => matchesBook(b, state.filters, "category"));
  const categories = [...new Set(booksForCategory.map((b) => b.category).filter(Boolean))]
    .sort((a, b) => a.localeCompare(b, "es", { sensitivity: "base" }))
    .map((cat) => ({ value: cat, label: cat }));

  if (state.filters.category && !categories.some((c) => c.value === state.filters.category)) {
    state.filters.category = "";
  }
  populateSelectOptions(
    els.categoryFilter,
    categories,
    state.filters.category,
    "Todas las categorías"
  );

  const booksForDecade = state.allBooks.filter((b) => matchesBook(b, state.filters, "decade"));
  const decadeMap = new Map();
  booksForDecade.forEach((b) => {
    if (b.decadeKey && !decadeMap.has(b.decadeKey)) {
      decadeMap.set(b.decadeKey, {
        value: b.decadeKey,
        label: b.decadeLabel,
        start: b.decadeStart
      });
    }
  });
  const decades = [...decadeMap.values()].sort((a, b) => b.start - a.start);

  if (state.filters.decade && !decades.some((d) => d.value === state.filters.decade)) {
    state.filters.decade = "";
  }
  populateSelectOptions(
    els.decadeFilter,
    decades,
    state.filters.decade,
    "Todos los años"
  );

  const booksForAuthor = state.allBooks.filter((b) => matchesBook(b, state.filters, "author"));
  const authors = [...new Set(booksForAuthor.map((b) => b.author).filter(Boolean))]
    .sort((a, b) => a.localeCompare(b, "es", { sensitivity: "base" }))
    .map((author) => ({ value: author, label: author }));

  if (state.filters.author && !authors.some((a) => a.value === state.filters.author)) {
    state.filters.author = "";
  }
  populateSelectOptions(
    els.authorFilter,
    authors,
    state.filters.author,
    "Todos los autores"
  );

  updateFilterBadge();
}

function updateFilterBadge() {
  let activeCount = 0;
  if (state.filters.search.trim()) activeCount += 1;
  if (state.filters.category) activeCount += 1;
  if (state.filters.decade) activeCount += 1;
  if (state.filters.author) activeCount += 1;
  if (state.filters.sort !== "novedades") activeCount += 1;

  if (activeCount > 0) {
    els.activeFilterBadge.textContent = String(activeCount);
    els.activeFilterBadge.hidden = false;
  } else {
    els.activeFilterBadge.hidden = true;
  }
}

function createBookCard(book) {
  const scene = document.createElement("div");
  scene.className = "book-card-scene";

  const card = document.createElement("article");
  card.className = "book-card";
  card.tabIndex = 0;
  card.setAttribute("role", "button");
  card.setAttribute("aria-pressed", "false");
  card.setAttribute("aria-label", `Ver ficha de ${book.title}`);

  // Frente de la tarjeta: Categoría, Título, Autor, Año y Portada
  const front = document.createElement("div");
  front.className = "card-face card-front";

  const topMeta = document.createElement("div");
  topMeta.className = "card-top-meta";

  const categorySpan = document.createElement("span");
  categorySpan.className = "category-pill";
  categorySpan.textContent = book.category;

  const yearSpan = document.createElement("span");
  yearSpan.className = "year-tag";
  yearSpan.textContent = book.yearLabel;

  topMeta.appendChild(categorySpan);
  if (book.yearLabel) {
    topMeta.appendChild(yearSpan);
  }

  const headerInfo = document.createElement("div");
  headerInfo.className = "card-header-info";

  const titleEl = document.createElement("h3");
  titleEl.className = "book-title";
  titleEl.textContent = book.title;

  const authorEl = document.createElement("p");
  authorEl.className = "book-author";
  authorEl.textContent = book.author;

  headerInfo.appendChild(titleEl);
  headerInfo.appendChild(authorEl);

  const coverFrame = document.createElement("div");
  coverFrame.className = "cover-frame";

  const coverImg = document.createElement("img");
  coverImg.className = "cover-image";
  coverImg.src = book.cover || FALLBACK_COVER_SVG;
  coverImg.alt = `Portada de ${book.title}`;
  coverImg.loading = "lazy";
  coverImg.addEventListener("error", () => {
    if (coverImg.src !== FALLBACK_COVER_SVG) {
      coverImg.src = FALLBACK_COVER_SVG;
    }
  });

  coverFrame.appendChild(coverImg);

  const hintEl = document.createElement("div");
  hintEl.className = "flip-hint";
  hintEl.innerHTML = `<span>Toca para ver ficha</span><span>↻</span>`;

  front.appendChild(topMeta);
  front.appendChild(headerInfo);
  front.appendChild(coverFrame);
  front.appendChild(hintEl);

  // Reverso de la tarjeta: Título, Autor, Año, Descripción, Pass y botón DESCARGA
  const back = document.createElement("div");
  back.className = "card-face card-back";

  const backHeader = document.createElement("div");
  backHeader.className = "back-header";

  const backTopRow = document.createElement("div");
  backTopRow.className = "back-top-row";

  const backCategory = document.createElement("span");
  backCategory.className = "category-pill";
  backCategory.textContent = book.category;

  const flipBackBtn = document.createElement("button");
  flipBackBtn.type = "button";
  flipBackBtn.className = "flip-back-btn";
  flipBackBtn.textContent = "Volver";

  backTopRow.appendChild(backCategory);
  backTopRow.appendChild(flipBackBtn);

  const backTitle = document.createElement("h3");
  backTitle.className = "back-title";
  backTitle.textContent = book.title;

  const backAuthorYear = document.createElement("p");
  backAuthorYear.className = "back-author-year";
  backAuthorYear.textContent = book.yearLabel
    ? `${book.author} · ${book.yearLabel}`
    : book.author;

  backHeader.appendChild(backTopRow);
  backHeader.appendChild(backTitle);
  backHeader.appendChild(backAuthorYear);

  const descScroll = document.createElement("div");
  descScroll.className = "back-description-scroll";

  const descP = document.createElement("p");
  descP.className = "back-description";
  descP.textContent = book.description;
  descScroll.appendChild(descP);

  const backFooter = document.createElement("div");
  backFooter.className = "back-footer";

  if (book.pass) {
    const passArea = document.createElement("div");
    passArea.className = "pass-area";

    const passBtn = document.createElement("button");
    passBtn.type = "button";
    passBtn.className = "btn-pass";
    passBtn.textContent = "Ver pass";

    const passBox = document.createElement("div");
    passBox.className = "pass-value";
    passBox.textContent = `Pass: ${book.pass}`;
    passBox.hidden = true;

    passBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      const isHidden = passBox.hidden;
      passBox.hidden = !isHidden;
      passBtn.textContent = isHidden ? "Ocultar pass" : "Ver pass";
    });

    passArea.appendChild(passBtn);
    passArea.appendChild(passBox);
    backFooter.appendChild(passArea);
  }

  if (book.link) {
    const downloadLink = document.createElement("a");
    downloadLink.className = "download-btn";
    downloadLink.href = book.link;
    downloadLink.target = "_blank";
    downloadLink.rel = "noopener noreferrer";
    downloadLink.textContent = "DESCARGA";
    downloadLink.addEventListener("click", (e) => {
      e.stopPropagation();
    });
    backFooter.appendChild(downloadLink);
  } else {
    const notice = document.createElement("p");
    notice.className = "link-notice";
    notice.textContent = "Enlace no disponible";
    backFooter.appendChild(notice);
  }

  back.appendChild(backHeader);
  back.appendChild(descScroll);
  back.appendChild(backFooter);

  card.appendChild(front);
  card.appendChild(back);
  scene.appendChild(card);

  const toggleFlip = (forceState = null) => {
    const nextFlipped =
      typeof forceState === "boolean" ? forceState : !card.classList.contains("is-flipped");
    card.classList.toggle("is-flipped", nextFlipped);
    card.setAttribute("aria-pressed", String(nextFlipped));
  };

  card.addEventListener("click", (e) => {
    if (e.target.closest("a, button, .back-description-scroll")) {
      return;
    }
    toggleFlip();
  });

  flipBackBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    toggleFlip(false);
  });

  card.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      if (document.activeElement === card) {
        e.preventDefault();
        toggleFlip();
      }
    } else if (e.key === "Escape" && card.classList.contains("is-flipped")) {
      toggleFlip(false);
    }
  });

  return scene;
}

function renderCatalog() {
  const booksToShow = getFilteredAndSortedBooks();
  const totalCount = state.allBooks.length;

  els.totalBooksFooter.textContent = `Libros disponibles: ${totalCount}`;

  if (booksToShow.length === 0) {
    els.booksGrid.hidden = true;
    els.emptyState.hidden = false;
    els.resultsCounter.textContent = `Mostrando 0 de ${totalCount} libros`;
    return;
  }

  els.emptyState.hidden = true;
  els.booksGrid.hidden = false;

  const fragment = document.createDocumentFragment();
  booksToShow.forEach((book) => {
    fragment.appendChild(createBookCard(book));
  });

  els.booksGrid.innerHTML = "";
  els.booksGrid.appendChild(fragment);

  els.resultsCounter.textContent = `Mostrando ${booksToShow.length} de ${totalCount} libros`;
}

function resetAllFilters() {
  state.filters.search = "";
  state.filters.category = "";
  state.filters.decade = "";
  state.filters.author = "";
  state.filters.sort = "novedades";

  els.searchInput.value = "";
  els.sortFilter.value = "novedades";

  updateDynamicFilterOptions();
  renderCatalog();
}

function bindEvents() {
  els.toggleFiltersBtn.addEventListener("click", () => {
    const isOpen = els.filtersPanel.classList.toggle("is-open");
    els.toggleFiltersBtn.setAttribute("aria-expanded", String(isOpen));
  });

  els.searchInput.addEventListener("input", (e) => {
    state.filters.search = e.target.value;
    updateDynamicFilterOptions();
    renderCatalog();
  });

  els.categoryFilter.addEventListener("change", (e) => {
    state.filters.category = e.target.value;
    updateDynamicFilterOptions();
    renderCatalog();
  });

  els.decadeFilter.addEventListener("change", (e) => {
    state.filters.decade = e.target.value;
    updateDynamicFilterOptions();
    renderCatalog();
  });

  els.authorFilter.addEventListener("change", (e) => {
    state.filters.author = e.target.value;
    updateDynamicFilterOptions();
    renderCatalog();
  });

  els.sortFilter.addEventListener("change", (e) => {
    state.filters.sort = e.target.value;
    renderCatalog();
  });

  els.clearFiltersBtn.addEventListener("click", resetAllFilters);
  els.emptyResetBtn.addEventListener("click", resetAllFilters);

  els.brandReset.addEventListener("click", (e) => {
    e.preventDefault();
    resetAllFilters();
    window.scrollTo({ top: 0, behavior: "smooth" });
  });
}

async function initCatalog() {
  bindEvents();

  try {
    const response = await fetch(TSV_URL, { cache: "no-store" });
    if (!response.ok) {
      throw new Error(`Error de red: ${response.status}`);
    }

    const tsvText = await response.text();
    state.allBooks = parseTSV(tsvText);

    els.statusMessage.hidden = true;
    updateDynamicFilterOptions();
    renderCatalog();
  } catch (error) {
    console.error("Error al cargar el catálogo:", error);
    els.statusMessage.textContent =
      "No se pudo cargar el catálogo desde Google Sheets en este momento. Verifica que la hoja esté publicada como TSV e inténtalo nuevamente.";
  }
}

initCatalog();
