// ==UserScript==
// @name         Manga Chapter CBZ Ripper
// @namespace    https://github.com/WhiteheadDesign/Manga-Chapter-CBZ-Ripper
// @version      9.1.1
// @description  Download manga chapters as CBZ files from supported sites
// @match        https://mangamillion.shueisha.co.jp/*
// @match        https://global.manga-up.com/*
// @match        https://www.ganganonline.com/*
// @match        https://zebrack-comic.shueisha.co.jp/*
// @match        https://mangaplus.shueisha.co.jp/*
// @match        https://bookwalker.com/*
// @author       WhiteheadDesign
// @license      MIT
// @icon         https://t3.gstatic.com/faviconV2?client=SOCIAL&type=FAVICON&fallback_opts=TYPE,SIZE,URL&url=http://mangaplus.shueisha.co.jp&size=32
// @run-at       document-start
// @grant        unsafeWindow
// @grant        GM_download
// ==/UserScript==

(function() {
    'use strict';

    // --- Core State & Globals ---
    const targetWindow = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
    const STORAGE_KEY_AUTO_DL = 'mm_auto_download_enabled';

    const state = {
        urlToBlob: new Map(),
        pageRegistry: new Map(),
        seenHashes: new Map(),
        isAutoScrolling: false,
        isDownloading: false,
        manualStop: false,
        autoDownload: localStorage.getItem(STORAGE_KEY_AUTO_DL) !== 'false',
        currentHref: window.location.href,
        currentMangaUpTitle: null,
        cachedProgressEl: null,
        cachedFolderName: null,
        lastProgressScan: 0
    };

    let syncTimeout = null;

    function updatePageBlur() {
        const overlay = document.getElementById('mm-blur-overlay');
        if (overlay) {
            overlay.style.visibility = state.isAutoScrolling || state.isDownloading ? 'visible' : 'hidden';
        }
    }

    // --- 0. UI Status Helper ---
    function setStatus(msg, isError = false) {
        const statusEl = document.getElementById('mm-status');
        if (!statusEl) return;
        if (!msg) {
            statusEl.style.display = 'none';
            return;
        }
        statusEl.style.display = 'block';
        statusEl.style.color = isError ? '#ff4c4c' : '#00e676';
        statusEl.innerText = msg;
    }

    // --- 0. Smart Folder Naming ---
    function getFolderName() {
        if (state.cachedFolderName) return state.cachedFolderName;

        let name = document.title.replace(/[<>:"/\\|?*]/g, "").trim();

        if (window.location.hostname.includes("manga-up.com")) {
            let chapText = "";
            const candidates = document.querySelectorAll('p, div, span, h1, h2');

            for (let i = 0; i < candidates.length; i++) {
                const txt = candidates[i].innerText ? candidates[i].innerText.trim() : "";
                if (/^(Chapter|Ep)\s*[\d.-]+/i.test(txt) && txt.length < 50) {
                    const rect = candidates[i].getBoundingClientRect();
                    if (rect.top >= 0 && rect.top < 150) {
                        chapText = txt;
                        break;
                    }
                }
            }
            const urlId = window.location.pathname.split('/').filter(Boolean).pop() || "Chap";
            name = chapText ? `MangaUP - ${chapText} (${urlId})` : `MangaUP - ${urlId}`;
        } else if (window.location.hostname.includes("ganganonline.com")) {
            const urlId = window.location.pathname.split('/').filter(Boolean).pop() || "";
            name = urlId ? `${name} ${urlId}` : name;
        }

        state.cachedFolderName = name.replace(/[<>:"/\\|?*]/g, "").trim() || "Manga_Chapter";
        return state.cachedFolderName;
    }

    // --- 0. SPA Navigation Reset ---
    function resetState() {
        state.urlToBlob.clear();
        state.pageRegistry.clear();
        state.seenHashes.clear();
        state.isAutoScrolling = false;
        state.isDownloading = false;
        state.manualStop = false;
        updatePageBlur();
        state.cachedProgressEl = null;
        state.cachedFolderName = null;
        state.lastProgressScan = 0;
        state.currentMangaUpTitle = null;

        const mainBtn = document.getElementById('mm-main-btn');
        if (mainBtn) {
            mainBtn.innerText = "Start Auto-Capture";
            mainBtn.style.background = "#e60012";
            mainBtn.disabled = false;
        }

        const totalInput = document.getElementById('mm-total');
        if (totalInput) {
            totalInput.value = "";
            delete totalInput.dataset.manual;
        }

        setStatus('');
        updateUI();
    }

    // --- 1. Detect Native Image Format ---
    async function detectExtension(blob) {
        if (blob.type && blob.type.startsWith('image/')) {
            const t = blob.type.split('/')[1].toLowerCase();
            if (['jpg', 'jpeg', 'png', 'webp', 'avif'].includes(t)) {
                return t === 'jpeg' ? 'jpg' : t;
            }
        }
        try {
            const buffer = new Uint8Array(await blob.slice(0, 16).arrayBuffer());
            if (buffer[0] === 0xFF && buffer[1] === 0xD8 && buffer[2] === 0xFF) return 'jpg';
            if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4E && buffer[3] === 0x47) return 'png';
            if (buffer[0] === 0x52 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x46) return 'webp';
            const ftyp = String.fromCharCode(...buffer.slice(4, 12));
            if (ftyp.includes('ftyp') || ftyp.includes('avif')) return 'avif';
        } catch (e) {}
        return 'jpg';
    }

    // --- 2. Lossless Format Converter (AVIF -> PNG) ---
    async function convertToPNG(blob) {
        return new Promise((resolve, reject) => {
            const img = new Image();
            const tempUrl = URL.createObjectURL(blob);
            let settled = false;
            const timeout = setTimeout(() => {
                finish(new Error("Image conversion timed out"));
            }, 30000);

            function finish(error, convertedBlob) {
                if (settled) return;
                settled = true;
                clearTimeout(timeout);
                URL.revokeObjectURL(tempUrl);
                if (error) reject(error);
                else resolve(convertedBlob);
            }

            img.onload = () => {
                if (settled) return;
                try {
                    const canvas = document.createElement('canvas');
                    canvas.width = img.naturalWidth;
                    canvas.height = img.naturalHeight;
                    const ctx = canvas.getContext('2d');
                    if (!ctx) throw new Error("Canvas context unavailable");
                    ctx.drawImage(img, 0, 0);

                    canvas.toBlob((newBlob) => {
                        if (newBlob) finish(null, newBlob);
                        else finish(new Error("Canvas conversion failed"));
                    }, 'image/png');
                } catch (error) {
                    finish(error instanceof Error ? error : new Error(String(error)));
                }
            };

            img.onerror = () => {
                finish(new Error("Image failed to load"));
            };

            img.src = tempUrl;
        });
    }

    // --- 2.5 Lightweight SHA-256 Blob Hashing ---
    async function getBlobHash(blob) {
        if (blob._cachedSha256) return blob._cachedSha256;
        try {
            const buffer = await blob.arrayBuffer();
            const hashBuffer = await crypto.subtle.digest('SHA-256', buffer);
            const hashArray = Array.from(new Uint8Array(hashBuffer));
            const hashHex = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
            blob._cachedSha256 = hashHex;
            return hashHex;
        } catch (e) {
            return null;
        }
    }

    // --- 3. The Hook (Shielded Primary Capture - Placeholder Filter) ---
    const originalCreateObjectURL = targetWindow.URL.createObjectURL;

    targetWindow.URL.createObjectURL = function(blob) {
        const url = originalCreateObjectURL.apply(this, arguments);

        if (state.isDownloading) return url;

        try {
            if (blob instanceof Blob && blob.size > 1024) {
                state.urlToBlob.set(url, blob);
                triggerSync();
            }
        } catch (e) {}
        return url;
    };

    // --- 4. Match Blobs to Real Page Numbers ---
    function extractPageNumber(img, fallbackIndex) {
        const attributes = [img.getAttribute('alt'), img.className, img.id].filter(Boolean).join(' ');
        const prefixMatch = attributes.match(/(?:page|content-p|p)[_-\s]*(\d+)/i);
        if (prefixMatch) return parseInt(prefixMatch[1], 10);
        const standaloneMatch = attributes.match(/\b(\d{2,4})\b/);
        if (standaloneMatch) return parseInt(standaloneMatch[1], 10);
        return fallbackIndex;
    }

    function triggerSync() {
        if (syncTimeout) clearTimeout(syncTimeout);
        syncTimeout = setTimeout(syncPagesWithDOM, 120);
    }

    async function syncPagesWithDOM() {
        if (state.isDownloading) return;

        const images = document.querySelectorAll('img[src^="blob:"]');
        let needsUIUpdate = false;
        let maxPageInDOM = -1;
        const isMangaPlus = window.location.hostname.includes("mangaplus.shueisha.co.jp");
        let seqPrev = -1;

        for (let i = 0; i < images.length; i++) {
            const img = images[i];
            let pageNum = extractPageNumber(img, i + 1);

            // Universal Anomaly Fix: Smooths out erroneous page jumps globally
            if (!isMangaPlus && seqPrev >= 0) {
                if (pageNum > seqPrev + 5) {
                    let expected = seqPrev + 1;
                    if (pageNum.toString().endsWith(expected.toString()) || (pageNum > 100 && seqPrev < 50)) {
                        pageNum = expected;
                    }
                }
            }
            if (pageNum < 500) seqPrev = pageNum;

            if (pageNum > maxPageInDOM && pageNum < 500) {
                maxPageInDOM = pageNum;
            }

            if (state.urlToBlob.has(img.src)) {
                const blob = state.urlToBlob.get(img.src);

                if (!state.pageRegistry.has(pageNum)) {
                    const hash = await getBlobHash(blob);
                    if (hash) {
                        if (!state.seenHashes.has(hash)) {
                            state.seenHashes.set(hash, [pageNum]);
                            state.pageRegistry.set(pageNum, blob);
                            needsUIUpdate = true;
                        } else {
                            const pagesWithHash = state.seenHashes.get(hash);
                            const isNew = pagesWithHash.every(p => Math.abs(p - pageNum) > 2);
                            if (isNew) {
                                pagesWithHash.push(pageNum);
                                state.pageRegistry.set(pageNum, blob);
                                needsUIUpdate = true;
                            }
                        }
                    } else {
                        state.pageRegistry.set(pageNum, blob);
                        needsUIUpdate = true;
                    }
                }
            }
        }

        if (needsUIUpdate) {
            updateUI();

            // Continuous Target Update Fallback Logic strictly isolated
            if (!isMangaPlus) {
                let maxReg = -1;
                for (const p of state.pageRegistry.keys()) {
                    if (p > maxReg && p < 500) maxReg = p;
                }
                const overallMax = Math.max(maxReg, maxPageInDOM);
                if (overallMax >= 0) {
                    let tempExpected = overallMax + 1;
                    if (state.pageRegistry.size > tempExpected) {
                        tempExpected = state.pageRegistry.size;
                    }
                    const totalInput = document.getElementById('mm-total');
                    const isBW = window.location.hostname.includes("bookwalker.com");
                    const isZB = window.location.hostname.includes("zebrack-comic.shueisha.co.jp");

                    if (totalInput && !totalInput.dataset.manual && !isBW) {
                        if (!isZB || (isZB && tempExpected > parseInt(totalInput.value.replace(/\D/g, '') || '0', 10))) {
                            totalInput.value = `/ ${tempExpected}`;
                        }
                    }
                }
            }
        }
    }

    // --- 5. Auto-detect Total Pages (OPTIMIZED) ---
    function getProgress() {
        const isMangaUp = window.location.hostname.includes("manga-up.com");
        const isGangan = window.location.hostname.includes("ganganonline.com");
        const isZebrack = window.location.hostname.includes("zebrack-comic.shueisha.co.jp");

        if (isMangaUp || isGangan) {
            return null;
        }

        if (isZebrack) {
            const pEls = document.querySelectorAll('p[class*="sc-dTci"], [class*="ghpMII"], p');
            for (let i = 0; i < pEls.length; i++) {
                const txt = pEls[i].textContent || '';
                const m = txt.trim().match(/(\d+)\s*\/\s*(\d+)/);
                if (m) {
                    let total = parseInt(m[2], 10);
                    if (total > 2) total -= 2;
                    return { current: parseInt(m[1], 10), total: total };
                }
            }
        }

        const bwRegex = /(?:(\d+)(?:[-–]\d+)?)\s*(?:\/|of)\s*(\d+)/i;

        const bwProg = document.getElementById('current-progression');
        if (bwProg && bwProg.innerText) {
            const match = bwProg.innerText.trim().match(bwRegex);
            if (match) return { current: parseInt(match[1], 10), total: parseInt(match[2], 10) };
        }

        if (state.cachedProgressEl && state.cachedProgressEl.offsetParent !== null) {
            const match = state.cachedProgressEl.innerText.trim().match(bwRegex);
            if (match) {
                let total = parseInt(match[2], 10);
                if (isZebrack && total > 2) total -= 2;
                return { current: parseInt(match[1], 10), total: total };
            }
        }

        const now = Date.now();
        if (now - state.lastProgressScan < 3000) return null;
        state.lastProgressScan = now;

        const allEls = document.querySelectorAll('div, span, p');
        for (let i = 0; i < allEls.length; i++) {
            const el = allEls[i];
            const txt = el.textContent;
            if (!txt || txt.length > 20) continue;

            const match = txt.trim().match(bwRegex);
            if (match) {
                if (el.offsetParent !== null) {
                    state.cachedProgressEl = el;
                    let total = parseInt(match[2], 10);
                    if (isZebrack && total > 2) total -= 2;
                    return { current: parseInt(match[1], 10), total: total };
                }
            }
        }
        return null;
    }

    // --- 6. SMART Auto-Scroll Logic ---
    async function smartAutoScroll() {
        state.isAutoScrolling = true;
        updatePageBlur();
        state.manualStop = false;
        const mainBtn = document.getElementById('mm-main-btn');
        mainBtn.innerText = "Stop Auto-Capture";
        mainBtn.style.background = "#f0ad4e";

        let progress = getProgress();
        const isBookwalker = window.location.hostname.includes("bookwalker.com");
        const isMangaPlus = window.location.hostname.includes("mangaplus.shueisha.co.jp");
        const isMangaUp = window.location.hostname.includes("manga-up.com");
        const isZebrack = window.location.hostname.includes("zebrack-comic.shueisha.co.jp");
        const isMangaMillion = window.location.hostname.includes("mangamillion.shueisha.co.jp");
        const isGangan = window.location.hostname.includes("ganganonline.com");
        const isSlideSite = isMangaUp || isZebrack || isMangaMillion;

        // --- Site Specific Rewind Detection ---
        let mangaPlusNeedsRewind = false;
        let ganganNeedsRewind = false;

        if (isMangaPlus) {
            const flexBar = document.querySelector('.zao-slider-bar-previous');
            if (flexBar && (flexBar.style.flexBasis !== '0%' && flexBar.style.flexBasis !== '0')) {
                mangaPlusNeedsRewind = true;
            }
        }

        if (isGangan) {
            const touchArea = document.querySelector('div[class*="Footer_footer__touchArea"]');
            if (touchArea && (touchArea.style.right !== '0%' && touchArea.style.right !== '0')) {
                ganganNeedsRewind = true;
            }
        }

        const getMangaUpSlider = () => document.querySelector('div[class*="Footer_footer__touchArea"]');
        const getSlideSeekSlider = () => document.querySelector('div[class*="sc-ieQsNB"], div[class*="imfsOI"], .AAXkwW_seek_area > div, [class*="seek_area"] div[style*="right"]');
        const getSlideSeekBar = () => document.querySelector('[class*="sc-itktkY"], [class*="bhHuBA"], [class*="remainBar"], .AAXkwW_seek_area ~ div[style*="width"], [class*="seek_area"] ~ div[style*="width"], [class*="seek_area"] div[style*="width"]');

        const mangaUpSlider = getMangaUpSlider();
        const slideSeekSlider = getSlideSeekSlider();

        const needsRewind = (progress && progress.current > 1) ||
                            ganganNeedsRewind ||
                            mangaPlusNeedsRewind ||
                            (isMangaUp && mangaUpSlider && mangaUpSlider.style.right !== '0%' && mangaUpSlider.style.right !== '0') ||
                            ((isZebrack || isMangaMillion) && slideSeekSlider && slideSeekSlider.style.right !== '0%' && slideSeekSlider.style.right !== '0') ||
                            (isMangaUp && !mangaUpSlider && window.scrollY > 100);

        async function executeRewind() {
            if (isMangaUp || isZebrack || isMangaMillion) {
                let rewindGuard = 0;
                while (rewindGuard < 300 && state.isAutoScrolling) {
                    const slider = isMangaUp ? getMangaUpSlider() : getSlideSeekSlider();
                    if (!slider || slider.style.right === '0%' || slider.style.right === '0') break;
                    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39, which: 39, bubbles: true }));
                    await new Promise(r => setTimeout(r, 100));
                    rewindGuard++;
                }
            } else if (isGangan) {
                let rewindGuard = 0;
                while (rewindGuard < 300 && state.isAutoScrolling) {
                    const touchArea = document.querySelector('div[class*="Footer_footer__touchArea"]');
                    if (!touchArea || touchArea.style.right === '0%' || touchArea.style.right === '0') break;
                    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39, which: 39, bubbles: true }));
                    await new Promise(r => setTimeout(r, 100));
                    rewindGuard++;
                }
            } else if (isMangaPlus) {
                let rewindGuard = 0;
                while (rewindGuard < 300 && state.isAutoScrolling) {
                    const flexBar = document.querySelector('.zao-slider-bar-previous');
                    if (!flexBar || flexBar.style.flexBasis === '0%' || flexBar.style.flexBasis === '0') break;
                    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39, which: 39, bubbles: true }));
                    const clickX = window.innerWidth - 10;
                    const clickY = window.innerHeight / 2;
                    const el = document.elementFromPoint(clickX, clickY);
                    if (el) el.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: clickX, clientY: clickY }));
                    await new Promise(r => setTimeout(r, 100));
                    rewindGuard++;
                }
            } else {
                if (isMangaMillion) {
                    window.scrollTo({ top: 0, behavior: 'smooth' });
                    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', code: 'Home', keyCode: 36, which: 36, bubbles: true }));
                    await new Promise(r => setTimeout(r, 500));
                }
                let rewindGuard = 0;
                let prog = getProgress();
                while (prog && prog.current > 1 && rewindGuard < 300 && state.isAutoScrolling) {
                    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', keyCode: 39, bubbles: true }));
                    if (isBookwalker) {
                        const bwGoBackwardBtn = document.querySelector('button[aria-label="Go backward"], button[aria-label*="backward" i]');
                        if (bwGoBackwardBtn) {
                            bwGoBackwardBtn.click();
                            bwGoBackwardBtn.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
                            bwGoBackwardBtn.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
                        }
                    }
                    await new Promise(r => setTimeout(r, 100));
                    prog = getProgress();
                    rewindGuard++;
                }
            }
            await new Promise(r => setTimeout(r, 800));
        }

        if (needsRewind) {
            setStatus('Rewinding to first page...', false);
            await executeRewind();
            setStatus('');
        }

        let mangaPlusLastFlex = null;
        let hasRewoundForMismatch = false;
        let noChangeStuck = 0;
        let prevSize = state.pageRegistry.size;

        while (state.isAutoScrolling) {
            const speed = parseInt(document.getElementById('mm-speed').value, 10);
            progress = getProgress();
            let newlyLoaded = false;

            // --- 1. INFINITE Auto-scroll Wait Logic (Waits until fully loaded) ---
            if (isMangaUp || isZebrack || isGangan) {
                while (state.isAutoScrolling) {
                    let containers = [];
                    const activeSpreads = Array.from(document.querySelectorAll('div[class*="spread"]')).filter(el => {
                        const rect = el.getBoundingClientRect();
                        return rect.right > 20 && rect.left < (window.innerWidth - 20);
                    });

                    if (activeSpreads.length > 0) {
                        activeSpreads.forEach(spread => {
                            const pContainers = spread.querySelectorAll('div[class*="page_container"], div[class*="pageContainer"]');
                            if (pContainers.length > 0) containers.push(...Array.from(pContainers));
                            else containers.push(spread);
                        });
                    }

                    if (containers.length === 0) {
                        containers = Array.from(document.querySelectorAll('div[class*="page_container"], div[class*="pageContainer"], [data-testid="placeholder"]')).filter(el => {
                            const rect = el.getBoundingClientRect();
                            return rect.right > 20 && rect.left < (window.innerWidth - 20) && rect.width > 50;
                        });
                    }

                    if (isGangan && containers.length === 0) {
                        containers = Array.from(document.querySelectorAll('div[class*="sc-cwHptR"]')).filter(el => {
                            const rect = el.getBoundingClientRect();
                            return rect.right > 20 && rect.left < (window.innerWidth - 20) && rect.width > 50;
                        });
                    }

                    if (containers.length > 0) {
                        let allLoaded = true;
                        for (const c of containers) {
                            const classStr = (c.className && typeof c.className === 'string') ? c.className : '';
                            const isEndOrAd = classStr.includes('viewer_last_lastpage') || classStr.includes('_b9ZNa_embed') || classStr.includes('_shadow_imphd_1') || classStr.includes('fluct-unit') ||
                                              c.querySelector('div[class*="_b9ZNa_embed"], div[class*="_shadow_imphd_1"], div[class*="viewer_last_lastpage"], div[class*="fluct-unit"]');

                            if (isEndOrAd) {
                                continue;
                            }
                            const img = c.querySelector('img') || (c.tagName.toLowerCase() === 'img' ? c : null);
                            const src = img ? (img.getAttribute('src') || '') : '';
                            if (!img || !src.startsWith('blob:') || !img.complete || img.naturalWidth <= 100) {
                                allLoaded = false;
                                break;
                            }
                        }

                        if (allLoaded) {
                            containers.forEach(c => {
                                const img = c.querySelector('img') || (c.tagName.toLowerCase() === 'img' ? c : null);
                                if (img && !img.dataset.scrollProcessed) {
                                    img.dataset.scrollProcessed = "true";
                                    newlyLoaded = true;
                                }
                            });
                            break;
                        }
                    } else {
                        break;
                    }
                    await new Promise(r => setTimeout(r, speed));
                }
            } else if (isSlideSite) {
                let visiblePlaceholders = Array.from(document.querySelectorAll('[data-testid="placeholder"]')).filter(el => {
                    const rect = el.getBoundingClientRect();
                    return rect.right > -50 && rect.left < (window.innerWidth + 50) && rect.width > 50;
                });

                if (visiblePlaceholders.length > 0) {
                    for (const placeholder of visiblePlaceholders) {
                        while (state.isAutoScrolling) {
                            const img = placeholder.querySelector('img');
                            if (img) {
                                const src = img.getAttribute('src') || '';
                                if (src.startsWith('blob:') && img.complete && img.naturalWidth > 100) {
                                    if (!img.dataset.scrollProcessed) {
                                        img.dataset.scrollProcessed = "true";
                                        newlyLoaded = true;
                                    }
                                    break;
                                }
                            }
                            await new Promise(r => setTimeout(r, speed));
                        }
                    }
                }
            } else if (isBookwalker) {
                while (state.isAutoScrolling) {
                    const visiblePageDivs = Array.from(document.querySelectorAll('div[data-page-number]')).filter(el => {
                        const rect = el.getBoundingClientRect();
                        return rect.right > -100 && rect.left < (window.innerWidth + 100) && rect.width > 50;
                    });

                    if (visiblePageDivs.length > 0) {
                        let allLoaded = true;
                        for (const div of visiblePageDivs) {
                            const img = div.querySelector('img[src^="blob:"]');
                            if (!img || !img.complete || img.naturalWidth <= 50) {
                                allLoaded = false;
                                break;
                            } else {
                                if (img.dataset.scrollProcessed !== "true") {
                                    img.dataset.scrollProcessed = "true";
                                    newlyLoaded = true;
                                }
                            }
                        }
                        if (allLoaded) break;
                    } else {
                        break;
                    }
                    await new Promise(r => setTimeout(r, speed));
                }
            } else if (isMangaPlus) {
                await new Promise(r => setTimeout(r, speed));
            } else {
                const visibleImgs = Array.from(document.querySelectorAll('img')).filter(el => {
                    const rect = el.getBoundingClientRect();
                    return rect.right > -300 && rect.left < (window.innerWidth + 300) && rect.width > 50;
                });

                for (const img of visibleImgs) {
                    while (state.isAutoScrolling) {
                        if (img.dataset.scrollProcessed === "true") break;
                        const src = img.getAttribute('src') || '';
                        if (src.startsWith('blob:') && img.complete && img.naturalWidth > 100) {
                            img.dataset.scrollProcessed = "true";
                            newlyLoaded = true;
                            break;
                        }
                        await new Promise(r => setTimeout(r, speed));
                    }
                }
            }

            if (newlyLoaded) {
                await new Promise(r => setTimeout(r, 150));
            }

            // --- Tracking variables for Stuck/Match state ---
            let curSize = state.pageRegistry.size;
            if (curSize === prevSize) {
                noChangeStuck++;
            } else {
                noChangeStuck = 0;
                prevSize = curSize;
            }

            let expectedTotal = progress ? progress.total : 0;
            if (!expectedTotal) {
                const totalInput = document.getElementById('mm-total');
                if (totalInput && totalInput.value) {
                    expectedTotal = parseInt(totalInput.value.replace(/\D/g, ''), 10);
                }
            }

            let dynamicExpected = expectedTotal;
            if (!isMangaPlus) {
                let maxPageFound = -1;
                let hasZero = false;
                let seqPrevLoc = -1;
                for (const pNum of state.pageRegistry.keys()) {
                    if (pNum === 0) hasZero = true;
                    if (pNum > maxPageFound && pNum < 500) maxPageFound = pNum;
                }
                document.querySelectorAll('img').forEach(img => {
                    const alt = img.getAttribute('alt') || '';
                    const match = alt.match(/(?:page|p)[_-\s]*(\d+)/i);
                    if (match) {
                        let pNum = parseInt(match[1], 10);

                        if (!isMangaPlus && seqPrevLoc >= 0) {
                            if (pNum > seqPrevLoc + 5) {
                                let expected = seqPrevLoc + 1;
                                if (pNum.toString().endsWith(expected.toString()) || (pNum > 100 && seqPrevLoc < 50)) {
                                    pNum = expected;
                                }
                            }
                        }
                        if (pNum < 500) seqPrevLoc = pNum;

                        if (pNum === 0) hasZero = true;
                        if (pNum > maxPageFound && pNum < 500) maxPageFound = pNum;
                    }
                });

                if (maxPageFound >= 0) {
                    dynamicExpected = (isMangaUp || isGangan || isZebrack || isMangaMillion || hasZero) ? maxPageFound + 1 : maxPageFound;
                }

                if (isZebrack) {
                    const prog = getProgress();
                    if (prog && prog.total > 0) {
                        dynamicExpected = prog.total;
                    } else if (maxPageFound >= 0) {
                        let zbCalc = maxPageFound + 1;
                        if (zbCalc > 2) zbCalc -= 2;
                        dynamicExpected = zbCalc;
                    }
                }

                // Fallback: If captured is greater than the calculated target, sync the target up
                if (curSize > dynamicExpected && dynamicExpected > 0) {
                    dynamicExpected = curSize;
                }
            }

            // --- Mid-scroll Target Match ---
            if (hasRewoundForMismatch && !isMangaPlus && !isZebrack) {
                let midTargetReached = isGangan ? (curSize >= dynamicExpected - 1) : (curSize >= dynamicExpected);
                if (dynamicExpected > 0 && midTargetReached) {
                    state.isAutoScrolling = false;
                    break;
                }
            }

            // --- 2. Site-specific End Stop Logic ---
            let endReached = false;

            if (isMangaUp) {
                const slider = document.querySelector('div[class*="Footer_footer__touchArea"]');
                const bar = document.querySelector('div[class*="Footer_footer__remainBar"]');

                let sliderAtEnd = false;
                if (slider && bar) {
                    const r = slider.style.right;
                    const w = bar.style.width;
                    if ((r === '100%' || r === '100') && (w === '0%' || w === '0')) sliderAtEnd = true;
                } else if (slider) {
                    const r = slider.style.right;
                    if (r === '100%' || r === '100') sliderAtEnd = true;
                }

                if (sliderAtEnd) {
                    endReached = true;
                }
            } else if (isGangan) {
                const slider = document.querySelector('div[class*="Footer_footer__touchArea"]');
                const bar = document.querySelector('div[class*="Footer_footer__remainBar"]');
                const lastPageBtn = document.querySelector('button[class*="viewer_viewer__lastPageButton"], button[class*="lastPageButton"]');

                if (lastPageBtn) {
                    endReached = true;
                } else if (slider) {
                    const r = parseFloat(slider.style.right);
                    // FIXED: Relaxed the floating point slider check from 99/1 to 95/5 to catch marginal scroll offsets that prevent triggering
                    if (r >= 95 || slider.style.right === '100%' || slider.style.right === '100') {
                        if (bar) {
                            const w = parseFloat(bar.style.width);
                            if (w <= 5 || bar.style.width === '0%' || bar.style.width === '0') {
                                endReached = true;
                            }
                        } else {
                            endReached = true;
                        }
                    }
                }

                // FIXED: Safe stuck-fallback specifically isolated for Gangan when target is matched
                if (!endReached && noChangeStuck > 8 && dynamicExpected > 0 && (curSize >= dynamicExpected - 1)) {
                    endReached = true;
                } else if (!endReached && noChangeStuck > 12) {
                    // FIXED: Unconditional stuck-fallback to force stop if stuck scrolling at chapter end, ensuring auto-download triggers
                    endReached = true;
                }
            } else if (isZebrack) {
                const zebrackSlider = document.querySelector('div[class*="sc-ieQsNB"], div[class*="imfsOI"], .AAXkwW_seek_area > div, [class*="seek_area"] div[style*="right"]');
                const zebrackBar = document.querySelector('[class*="sc-itktkY"], [class*="bhHuBA"], [class*="remainBar"], .AAXkwW_seek_area ~ div[style*="width"], [class*="seek_area"] ~ div[style*="width"]');

                if (zebrackSlider && zebrackBar) {
                    const r = parseFloat(zebrackSlider.style.right);
                    const w = parseFloat(zebrackBar.style.width);
                    if (r >= 99 || zebrackSlider.style.right === '100%' || zebrackSlider.style.right === '100') {
                        if (w <= 1 || zebrackBar.style.width === '0%' || zebrackBar.style.width === '0') {
                            endReached = true;
                        }
                    }
                } else if (zebrackSlider) {
                    const r = parseFloat(zebrackSlider.style.right);
                    if (r >= 99 || zebrackSlider.style.right === '100%' || zebrackSlider.style.right === '100') {
                        endReached = true;
                    }
                }

                // Safe stuck-fallback specifically isolated for Zebrack
                if (!endReached && noChangeStuck > 12 && dynamicExpected > 0 && curSize >= dynamicExpected) {
                    endReached = true;
                }
            } else if (isBookwalker) {
                const bwForwardBtn = document.querySelector('button[aria-label="Go forward"], button[aria-label*="forward" i]');
                const bwIsEnd = progress && progress.current >= progress.total;
                const bwBtnDisabled = bwForwardBtn && (bwForwardBtn.disabled || bwForwardBtn.getAttribute('aria-disabled') === 'true');
                if (bwIsEnd || bwBtnDisabled) {
                    endReached = true;
                }
            }

            if (endReached) {
                await new Promise(r => setTimeout(r, 800)); // Ensure final rendering finishes to capture dynamic expected count
                await syncPagesWithDOM();
                curSize = state.pageRegistry.size;

                if (!isMangaPlus) {
                    let maxPageFound = -1;
                    let hasZero = false;
                    let seqPrevLoc = -1;
                    for (const pNum of state.pageRegistry.keys()) {
                        if (pNum === 0) hasZero = true;
                        if (pNum > maxPageFound && pNum < 500) maxPageFound = pNum;
                    }
                    document.querySelectorAll('img').forEach(img => {
                        const alt = img.getAttribute('alt') || '';
                        const match = alt.match(/(?:page|p)[_-\s]*(\d+)/i);
                        if (match) {
                            let pNum = parseInt(match[1], 10);

                            if (!isMangaPlus && seqPrevLoc >= 0) {
                                if (pNum > seqPrevLoc + 5) {
                                    let expected = seqPrevLoc + 1;
                                    if (pNum.toString().endsWith(expected.toString()) || (pNum > 100 && seqPrevLoc < 50)) {
                                        pNum = expected;
                                    }
                                }
                            }
                            if (pNum < 500) seqPrevLoc = pNum;

                            if (pNum === 0) hasZero = true;
                            if (pNum > maxPageFound && pNum < 500) maxPageFound = pNum;
                        }
                    });

                    if (maxPageFound >= 0) {
                        dynamicExpected = (isMangaUp || isGangan || isZebrack || isMangaMillion || hasZero) ? maxPageFound + 1 : maxPageFound;
                    }

                    if (isZebrack) {
                        const prog = getProgress();
                        if (prog && prog.total > 0) {
                            dynamicExpected = prog.total;
                        } else if (maxPageFound >= 0) {
                            let zbCalc = maxPageFound + 1;
                            if (zbCalc > 2) zbCalc -= 2;
                            dynamicExpected = zbCalc;
                        }
                    }

                    // Fallback: If captured is greater than the calculated target, sync the target up
                    if (curSize > dynamicExpected && dynamicExpected > 0) {
                        dynamicExpected = curSize;
                    }
                }

                if (dynamicExpected > 0) {
                    let targetReached = isGangan ? (curSize >= dynamicExpected - 1) : (curSize >= dynamicExpected);
                    let needsFallback = isGangan ? (curSize <= dynamicExpected - 2) : (curSize < dynamicExpected);

                    if (targetReached) {
                        state.isAutoScrolling = false;
                        break;
                    } else if (needsFallback) {
                        setStatus(`Mismatch (${curSize}/${dynamicExpected}). Rewinding to re-scan...`, true);
                        hasRewoundForMismatch = true;
                        noChangeStuck = 0;
                        await executeRewind();
                        continue;
                    } else {
                        state.isAutoScrolling = false;
                        break;
                    }
                } else {
                    state.isAutoScrolling = false;
                    break;
                }
            }

            // Ensures that the missing-image auto-rewind fallback correctly monitors all supported sites except MangaPlus
            if (!isMangaPlus) {
                if (noChangeStuck > 8) {
                    let targetReached = isGangan ? (curSize >= dynamicExpected - 1) : (curSize >= dynamicExpected);
                    let needsFallback = isGangan ? (curSize <= dynamicExpected - 2) : (curSize < dynamicExpected);

                    if (dynamicExpected > 0 && targetReached) {
                        state.isAutoScrolling = false;
                        break;
                    } else if (dynamicExpected > 0 && needsFallback) {
                        setStatus(`Mismatch (${curSize}/${dynamicExpected}). Rewinding to re-scan...`, true);
                        hasRewoundForMismatch = true;
                        noChangeStuck = 0;
                        await executeRewind();
                        continue;
                    } else {
                        state.isAutoScrolling = false;
                        break;
                    }
                }
            }

            if (isMangaPlus) {
                const flexBar = document.querySelector('.zao-slider-bar-previous');
                if (flexBar) {
                    const currentFlex = flexBar.style.flexBasis;
                    if (parseFloat(currentFlex) >= 99) {
                        state.isAutoScrolling = false;
                        break;
                    }
                }
            }

            // --- 3. Advance to Next Page ---
            if (state.isAutoScrolling) {
                document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37, which: 37, bubbles: true }));

                if (isMangaPlus) {
                    const clickX = 10;
                    const clickY = window.innerHeight / 2;
                    const el = document.elementFromPoint(clickX, clickY);
                    if (el) el.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: clickX, clientY: clickY }));
                } else if (isBookwalker) {
                    const bwGoForwardBtn = document.querySelector('button[aria-label="Go forward"], button[aria-label*="forward" i]');
                    if (bwGoForwardBtn) {
                        bwGoForwardBtn.click();
                        bwGoForwardBtn.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
                        bwGoForwardBtn.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
                    }
                }

                await new Promise(r => setTimeout(r, 60));
                await syncPagesWithDOM();
            }
        }

        // --- Post-Loop Strict Match Checks ---
        if (!state.isAutoScrolling) {
            await syncPagesWithDOM();
            mainBtn.innerText = "Start Auto-Capture";
            mainBtn.style.background = "#e60012";

            let expectedTotal = 0;

            if (!isMangaPlus) {
                let maxPageFound = -1;
                let hasZero = false;
                let seqPrevLoc = -1;
                for (const pNum of state.pageRegistry.keys()) {
                    if (pNum === 0) hasZero = true;
                    if (pNum > maxPageFound && pNum < 500) maxPageFound = pNum;
                }
                document.querySelectorAll('img').forEach(img => {
                    const alt = img.getAttribute('alt') || '';
                    const match = alt.match(/(?:page|p)[_-\s]*(\d+)/i);
                    if (match) {
                        let pNum = parseInt(match[1], 10);

                        if (!isMangaPlus && seqPrevLoc >= 0) {
                            if (pNum > seqPrevLoc + 5) {
                                let expected = seqPrevLoc + 1;
                                if (pNum.toString().endsWith(expected.toString()) || (pNum > 100 && seqPrevLoc < 50)) {
                                    pNum = expected;
                                }
                            }

                        }
                        if (pNum < 500) seqPrevLoc = pNum;

                        if (pNum === 0) hasZero = true;
                        if (pNum > maxPageFound && pNum < 500) maxPageFound = pNum;
                    }
                });

                if (maxPageFound >= 0) {
                    expectedTotal = (isMangaUp || isGangan || isZebrack || isMangaMillion || hasZero) ? maxPageFound + 1 : maxPageFound;
                }

                if (isZebrack) {
                    const prog = getProgress();
                    if (prog && prog.total > 0) {
                        expectedTotal = prog.total;
                    } else if (maxPageFound >= 0) {
                        let zbCalc = maxPageFound + 1;
                        if (zbCalc > 2) zbCalc -= 2;
                        expectedTotal = zbCalc;
                    }
                }

                // Fallback: If captured is greater than the calculated target, sync the target up
                if (state.pageRegistry.size > expectedTotal && expectedTotal > 0) {
                    expectedTotal = state.pageRegistry.size;
                }

                if (expectedTotal > 0) {
                    const totalInput = document.getElementById('mm-total');
                    if (totalInput && !totalInput.dataset.manual) totalInput.value = `/ ${expectedTotal}`;
                }
            } else {
                const prog = getProgress();
                expectedTotal = prog ? prog.total : 0;
                if (!expectedTotal) {
                    const totalInput = document.getElementById('mm-total');
                    if (totalInput && totalInput.value) {
                        expectedTotal = parseInt(totalInput.value.replace(/\D/g, ''), 10);
                    }
                }
            }

            if (expectedTotal > 0) {
                let finalTargetMatched = isGangan ? (state.pageRegistry.size >= expectedTotal - 1) : (state.pageRegistry.size >= expectedTotal);

                if (finalTargetMatched) {
                    if (state.autoDownload && !state.manualStop) {
                        setStatus(`All ${state.pageRegistry.size} panels captured! Downloading...`, false);
                        downloadToFolder();
                    } else {
                        setStatus(`All ${state.pageRegistry.size} panels captured! Click Download Captured to save.`, false);
                    }
                } else {
                    if (!isMangaPlus) {
                         setStatus(`Mismatch warning: Captured ${state.pageRegistry.size}/${expectedTotal} panels. Auto-download aborted.`, true);
                    } else {
                         if (state.autoDownload && !state.manualStop) {
                             setStatus(`Mismatch warning: Captured ${state.pageRegistry.size}/${expectedTotal} panels. Downloading anyway...`, true);
                             downloadToFolder();
                         } else {
                             setStatus(`Mismatch warning: Captured ${state.pageRegistry.size}/${expectedTotal} panels. Click Download Captured to save.`, true);
                         }
                    }
                }
            } else {
                if (state.autoDownload && !state.manualStop) {
                    downloadToFolder();
                } else {
                    setStatus('All panels captured! Click Download Captured to save.', false);
                }
            }
        }
        updatePageBlur();
    }

    // --- 7. Manga-UP Canvas Fallback Method ---
    async function captureMissedImagesMangaUp() {
        if (!window.location.hostname.includes("manga-up.com")) return;

        const images = document.querySelectorAll('img[src^="blob:"]');
        let missedCount = 0;

        for (let i = 0; i < images.length; i++) {
            const img = images[i];
            if (!state.urlToBlob.has(img.src) && img.complete && img.naturalWidth > 100) {
                try {
                    const canvas = document.createElement('canvas');
                    canvas.width = img.naturalWidth;
                    canvas.height = img.naturalHeight;
                    const ctx = canvas.getContext('2d');
                    ctx.drawImage(img, 0, 0);

                    const blob = await new Promise(res => canvas.toBlob(res, 'image/jpeg', 0.95));
                    if (blob && blob.size > 1024) {
                        state.urlToBlob.set(img.src, blob);
                        missedCount++;
                    }
                } catch (e) {}
            }
        }
        if (missedCount > 0) await syncPagesWithDOM();
    }

    const crc32Table = new Uint32Array(256);
    for (let i = 0; i < crc32Table.length; i++) {
        let value = i;
        for (let bit = 0; bit < 8; bit++) {
            value = (value & 1) ? (0xEDB88320 ^ (value >>> 1)) : (value >>> 1);
        }
        crc32Table[i] = value >>> 0;
    }

    function updateCRC32(bytes, crc) {
        for (let i = 0; i < bytes.length; i++) {
            crc = crc32Table[(crc ^ bytes[i]) & 0xFF] ^ (crc >>> 8);
        }
        return crc >>> 0;
    }

    async function calculateBlobCRC32(blob) {
        const chunkSize = 1024 * 1024;
        let crc = 0xFFFFFFFF;

        for (let offset = 0; offset < blob.size; offset += chunkSize) {
            const chunk = new Uint8Array(await blob.slice(offset, offset + chunkSize).arrayBuffer());
            crc = updateCRC32(chunk, crc);
            await new Promise(resolve => setTimeout(resolve, 0));
        }

        return (crc ^ 0xFFFFFFFF) >>> 0;
    }

    async function createCBZ(files, onProgress) {
        if (files.length > 0xFFFF) {
            throw new Error('The chapter has too many images for a CBZ archive.');
        }

        const encoder = new TextEncoder();
        const localParts = [];
        const centralParts = [];
        const now = new Date();
        const dosTime = (now.getHours() << 11) | (now.getMinutes() << 5) | Math.floor(now.getSeconds() / 2);
        const dosDate = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
        let localOffset = 0;

        for (let index = 0; index < files.length; index++) {
            const file = files[index];
            const filename = encoder.encode(file.name);
            if (filename.length > 0xFFFF || file.blob.size > 0xFFFFFFFF) {
                throw new Error(`Image cannot be stored in a standard CBZ archive: ${file.name}`);
            }

            onProgress(index + 1, files.length);
            const crc = await calculateBlobCRC32(file.blob);
            const localHeader = new Uint8Array(30 + filename.length);
            const localView = new DataView(localHeader.buffer);
            localView.setUint32(0, 0x04034B50, true);
            localView.setUint16(4, 20, true);
            localView.setUint16(6, 0x0800, true);
            localView.setUint16(8, 0, true);
            localView.setUint16(10, dosTime, true);
            localView.setUint16(12, dosDate, true);
            localView.setUint32(14, crc, true);
            localView.setUint32(18, file.blob.size, true);
            localView.setUint32(22, file.blob.size, true);
            localView.setUint16(26, filename.length, true);
            localView.setUint16(28, 0, true);
            localHeader.set(filename, 30);
            localParts.push(localHeader, file.blob);

            const centralHeader = new Uint8Array(46 + filename.length);
            const centralView = new DataView(centralHeader.buffer);
            centralView.setUint32(0, 0x02014B50, true);
            centralView.setUint16(4, 20, true);
            centralView.setUint16(6, 20, true);
            centralView.setUint16(8, 0x0800, true);
            centralView.setUint16(10, 0, true);
            centralView.setUint16(12, dosTime, true);
            centralView.setUint16(14, dosDate, true);
            centralView.setUint32(16, crc, true);
            centralView.setUint32(20, file.blob.size, true);
            centralView.setUint32(24, file.blob.size, true);
            centralView.setUint16(28, filename.length, true);
            centralView.setUint16(30, 0, true);
            centralView.setUint16(32, 0, true);
            centralView.setUint16(34, 0, true);
            centralView.setUint16(36, 0, true);
            centralView.setUint32(38, 0, true);
            centralView.setUint32(42, localOffset, true);
            centralHeader.set(filename, 46);
            centralParts.push(centralHeader);

            localOffset += localHeader.length + file.blob.size;
            if (localOffset > 0xFFFFFFFF) {
                throw new Error('The chapter is too large for a standard CBZ archive.');
            }
        }

        const centralDirectory = new Blob(centralParts);
        const endRecord = new Uint8Array(22);
        const endView = new DataView(endRecord.buffer);
        endView.setUint32(0, 0x06054B50, true);
        endView.setUint16(4, 0, true);
        endView.setUint16(6, 0, true);
        endView.setUint16(8, files.length, true);
        endView.setUint16(10, files.length, true);
        endView.setUint32(12, centralDirectory.size, true);
        endView.setUint32(16, localOffset, true);
        endView.setUint16(20, 0, true);

        return new Blob([...localParts, centralDirectory, endRecord], { type: 'application/vnd.comicbook+zip' });
    }

    // --- 8. Download captured pages as a CBZ archive ---
    async function downloadToFolder() {
        if (state.isDownloading) return;

        const btn = document.getElementById('mm-dedicated-dl-btn');
        const mainBtn = document.getElementById('mm-main-btn');
        state.isDownloading = true;
        updatePageBlur();

        try {
            if (window.location.hostname.includes("manga-up.com")) {
                setStatus('Checking for missed images...', false);
                btn.disabled = true;
                mainBtn.disabled = true;
                await captureMissedImagesMangaUp();
            }

            await syncPagesWithDOM();

            if (state.pageRegistry.size === 0) {
                setStatus('No pages captured yet! Scroll first.', true);
                return;
            }

            setStatus('Preparing CBZ archive...', false);
            btn.innerText = "Creating CBZ...";
            btn.disabled = true;
            mainBtn.disabled = true;
            const cleanTitle = getFolderName();
            const sortedPages = Array.from(state.pageRegistry.entries()).sort((a, b) => a[0] - b[0]);
            const pad = Math.max(String(sortedPages[sortedPages.length - 1][0]).length, 3);

            const files = [];
            for (let index = 0; index < sortedPages.length; index++) {
                const [pageNum, originalBlob] = sortedPages[index];
                setStatus(`Converting image ${index + 1}/${sortedPages.length}...`, false);
                btn.innerText = `Converting ${index + 1}/${sortedPages.length}`;
                await new Promise(resolve => setTimeout(resolve, 0));

                let finalBlob = originalBlob;
                let ext = 'png';

                try {
                    finalBlob = await convertToPNG(originalBlob);
                } catch (e) {
                    ext = await detectExtension(originalBlob);
                }

                files.push({
                    name: `Page_${String(pageNum).padStart(pad, '0')}.${ext}`,
                    blob: finalBlob
                });
            }

            setStatus('Building CBZ archive...', false);
            const archiveBlob = await createCBZ(files, (current, total) => {
                setStatus(`Adding image ${current}/${total} to CBZ...`, false);
                btn.innerText = `Archiving ${current}/${total}`;
            });
            const blobUrl = targetWindow.URL.createObjectURL(archiveBlob);
            let usedAnchorFallback = false;
            try {
                await new Promise((resolve, reject) => {
                    let downloadHandled = false;
                    GM_download({
                        url: blobUrl,
                        name: `${cleanTitle}.cbz`,
                        saveAs: false,
                        onload: () => {
                            if (downloadHandled) return;
                            downloadHandled = true;
                            resolve();
                        },
                        onerror: () => {
                            if (downloadHandled) return;
                            downloadHandled = true;
                            try {
                                usedAnchorFallback = true;
                                const link = document.createElement('a');
                                link.href = blobUrl;
                                link.download = `${cleanTitle}.cbz`;
                                link.style.display = 'none';
                                (document.body || document.documentElement).appendChild(link);
                                link.click();
                                link.remove();
                                resolve();
                            } catch (error) {
                                reject(new Error(`CBZ download failed: ${error instanceof Error ? error.message : 'browser rejected the download'}`));
                            }
                        }
                    });
                });
            } finally {
                if (usedAnchorFallback) {
                    setTimeout(() => targetWindow.URL.revokeObjectURL(blobUrl), 60000);
                } else {
                    targetWindow.URL.revokeObjectURL(blobUrl);
                }
            }

            btn.innerText = "Done!";
            setStatus('CBZ downloaded successfully.', false);
            setTimeout(() => {
                btn.innerText = "Download Captured";
                btn.disabled = false;
                mainBtn.innerText = "Start Auto-Capture";
                mainBtn.style.background = "#e60012";
                mainBtn.disabled = false;
                state.isDownloading = false;
                updatePageBlur();
                setStatus('');
            }, 3000);
        } catch (error) {
            console.error('Error creating or downloading CBZ:', error);
            const message = error instanceof Error ? error.message : String(error);
            setStatus(`CBZ download failed: ${message}`, true);
            btn.innerText = "Download Captured";
            btn.disabled = false;
            mainBtn.innerText = "Start Auto-Capture";
            mainBtn.style.background = "#e60012";
            mainBtn.disabled = false;
            state.isDownloading = false;
            updatePageBlur();
        }

        if (state.pageRegistry.size === 0) {
            btn.innerText = "Download Captured";
            btn.disabled = false;
            mainBtn.innerText = "Start Auto-Capture";
            mainBtn.style.background = "#e60012";
            mainBtn.disabled = false;
            state.isDownloading = false;
            updatePageBlur();
        }
    }

    function handleMainButtonClick() {
        if (state.isDownloading) return;

        if (state.isAutoScrolling) {
            state.isAutoScrolling = false;
            updatePageBlur();
            state.manualStop = true;
            const mainBtn = document.getElementById('mm-main-btn');
            mainBtn.innerText = "Start Auto-Capture";
            mainBtn.style.background = "#e60012";
            return;
        }
        smartAutoScroll();
    }

    // --- 9. UI Construction & Updates ---
    function updateUI() {
        const count = document.getElementById('mm-count');
        if (count) count.innerText = state.pageRegistry.size;
    }

    let lastIntervalSync = 0;

    setInterval(() => {
        updatePageBlur();
        let triggerReset = false;

        if (window.location.href !== state.currentHref) {
            state.currentHref = window.location.href;
            triggerReset = true;
        }

        if (window.location.hostname.includes("manga-up.com")) {
            const h1 = document.querySelector('h1[class^="Header_title"]');
            if (h1 && h1.innerText) {
                const currentTitle = h1.innerText.trim();
                if (state.currentMangaUpTitle !== null && state.currentMangaUpTitle !== currentTitle) {
                    triggerReset = true;
                }
                state.currentMangaUpTitle = currentTitle;
            }
        }

        if (triggerReset) {
            resetState();
            if (window.location.hostname.includes("manga-up.com")) {
                const h1 = document.querySelector('h1[class^="Header_title"]');
                if (h1) state.currentMangaUpTitle = h1.innerText.trim();
            }
        }

        const now = Date.now();
        if (!state.isDownloading && !state.isAutoScrolling && now - lastIntervalSync > 1500) {
            syncPagesWithDOM();
            lastIntervalSync = now;
        }

        const progress = getProgress();
        const totalInput = document.getElementById('mm-total');
        if (progress && totalInput && !totalInput.dataset.manual) {
            totalInput.value = `/ ${progress.total}`;
        }
    }, 500);

    window.addEventListener('DOMContentLoaded', () => {
        const style = document.createElement('style');
        style.textContent = `
            #mm-modal {
                position: fixed;
                top: 15%;
                right: 20px;
                z-index: 999999;
                background: #141416;
                color: #ffffff;
                padding: 14px;
                border-radius: 12px;
                font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
                box-shadow: 0 10px 30px rgba(0,0,0,0.7), 0 0 1px rgba(255,255,255,0.2);
                width: 230px;
                border: 1px solid #27272a;
                user-select: none;
            }
            #mm-blur-overlay {
                position: fixed;
                inset: 0;
                z-index: 999998;
                pointer-events: none;
                visibility: hidden;
                -webkit-backdrop-filter: blur(12px);
                backdrop-filter: blur(12px);
            }
            #mm-header {
                cursor: grab;
                display: flex;
                align-items: center;
                justify-content: space-between;
                padding-bottom: 10px;
                border-bottom: 1px solid #27272a;
                margin-bottom: 12px;
            }
            #mm-header:active {
                cursor: grabbing;
            }
            .mm-title {
                font-size: 11px;
                font-weight: 700;
                letter-spacing: 0.8px;
                color: #e4e4e7;
            }
            .mm-min-btn {
                background: transparent;
                border: none;
                color: #a1a1aa;
                cursor: pointer;
                font-size: 16px;
                line-height: 1;
                padding: 0 4px;
            }
            .mm-min-btn:hover {
                color: #ffffff;
            }
            #mm-speed {
                -webkit-appearance: none !important;
                appearance: none !important;
                accent-color: #e60012 !important;
                width: 100% !important;
                background: transparent !important;
                margin: 6px 0 !important;
                cursor: pointer !important;
            }
            #mm-speed::-webkit-slider-runnable-track {
                width: 100% !important;
                height: 5px !important;
                background: #e60012 !important;
                border-radius: 3px !important;
            }
            #mm-speed::-webkit-slider-thumb {
                -webkit-appearance: none !important;
                height: 15px !important;
                width: 15px !important;
                border-radius: 50% !important;
                background: #ffffff !important;
                margin-top: -5px !important;
                box-shadow: 0 0 4px rgba(0,0,0,0.6) !important;
            }
            #mm-speed::-moz-range-track {
                width: 100% !important;
                height: 5px !important;
                background: #e60012 !important;
                border-radius: 3px !important;
            }
            #mm-speed::-moz-range-thumb {
                height: 15px !important;
                width: 15px !important;
                border: none !important;
                border-radius: 50% !important;
                background: #ffffff !important;
            }
            .mm-toggle-row {
                display: flex;
                align-items: center;
                justify-content: space-between;
                margin-bottom: 12px;
                font-size: 11px;
                color: #d4d4d8;
            }
            .mm-switch {
                position: relative;
                display: inline-block;
                width: 32px;
                height: 18px;
            }
            .mm-switch input {
                opacity: 0;
                width: 0;
                height: 0;
            }
            .mm-slider {
                position: absolute;
                cursor: pointer;
                top: 0; left: 0; right: 0; bottom: 0;
                background-color: #3f3f46;
                transition: .2s;
                border-radius: 18px;
            }
            .mm-slider:before {
                position: absolute;
                content: "";
                height: 12px;
                width: 12px;
                left: 3px;
                bottom: 3px;
                background-color: white;
                transition: .2s;
                border-radius: 50%;
            }
            input:checked + .mm-slider {
                background-color: #00e676;
            }
            input:checked + .mm-slider:before {
                transform: translateX(14px);
            }
            .mm-support-link {
                color: #f0ad4e;
                text-decoration: none;
                font-size: 10px;
                display: block;
                margin-top: 8px;
                text-align: center;
            }
            .mm-support-link:hover {
                color: #ffffff;
            }
        `;
        document.head.appendChild(style);

        const blurOverlay = document.createElement('div');
        blurOverlay.id = 'mm-blur-overlay';
        blurOverlay.setAttribute('aria-hidden', 'true');
        document.body.appendChild(blurOverlay);

        const ui = document.createElement('div');
        ui.id = 'mm-modal';
        ui.innerHTML = `
            <div id="mm-header">
                <span class="mm-title">MANGA RIPPER</span>
                <button class="mm-min-btn" id="mm-toggle-min">−</button>
            </div>

            <div id="mm-body">
                <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px; background: #202024; padding: 8px 10px; border-radius: 6px;">
                    <span style="font-size: 13px; font-weight: 600; color: #00e676;">Captured: <span id="mm-count">0</span></span>
                    <input type="text" id="mm-total" placeholder="/ Total" style="width: 50px; background: transparent; border: none; color: #71717a; text-align: right; font-size: 12px; font-weight: 600;" title="Auto-detects, or manually input">
                </div>

                <div style="margin-bottom: 10px;">
                    <label style="font-size: 10px; color: #a1a1aa; display: block; margin-bottom: 3px;" id="mm-speed-lbl">Scroll Delay: 50ms</label>
                    <input type="range" id="mm-speed" min="50" max="2500" step="50" value="50">
                </div>

                <div class="mm-toggle-row">
                    <span>Auto-Download</span>
                    <label class="mm-switch">
                        <input type="checkbox" id="mm-auto-dl-toggle" ${state.autoDownload ? 'checked' : ''}>
                        <span class="mm-slider"></span>
                    </label>
                </div>

                <div id="mm-status" style="font-size: 11px; font-weight: 600; margin-bottom: 8px; text-align: center; display: none; line-height: 1.2;"></div>

                <button id="mm-main-btn" style="width: 100%; padding: 10px; background: #e60012; color: white; border: none; border-radius: 6px; font-size: 12px; font-weight: 700; cursor: pointer; transition: background 0.2s; margin-bottom: 8px;">Start Auto-Capture</button>
                <button id="mm-dedicated-dl-btn" style="width: 100%; padding: 10px; background: #2563eb; color: white; border: none; border-radius: 6px; font-size: 12px; font-weight: 700; cursor: pointer; transition: background 0.2s;">Download Captured</button>
                <a href="https://www.buymeacoffee.com/ozler" target="_blank" class="mm-support-link">☕ Support the Developer</a>
            </div>
        `;

        document.body.appendChild(ui);
        updatePageBlur();

        const stopProp = (e) => e.stopPropagation();
        const interactiveEls = ui.querySelectorAll('button, input, .mm-slider');
        interactiveEls.forEach(el => {
            el.addEventListener('click', stopProp);
            el.addEventListener('mousedown', stopProp);
            el.addEventListener('pointerdown', stopProp);
            el.addEventListener('touchstart', stopProp, {passive: true});
        });

        const bodyEl = document.getElementById('mm-body');
        const minBtn = document.getElementById('mm-toggle-min');
        let isMinimized = false;
        minBtn.onclick = () => {
            isMinimized = !isMinimized;
            bodyEl.style.display = isMinimized ? 'none' : 'block';
            minBtn.innerText = isMinimized ? '+' : '−';
            ui.style.width = isMinimized ? '130px' : '230px';
        };

        const headerEl = document.getElementById('mm-header');
        let isDragging = false, startX, startY, initLeft, initTop;

        headerEl.addEventListener('mousedown', (e) => {
            if (e.target === minBtn) return;
            isDragging = true;
            startX = e.clientX;
            startY = e.clientY;
            const rect = ui.getBoundingClientRect();
            initLeft = rect.left;
            initTop = rect.top;
            ui.style.right = 'auto';
            ui.style.left = `${initLeft}px`;
            ui.style.top = `${initTop}px`;
        });

        window.addEventListener('mousemove', (e) => {
            if (!isDragging) return;
            ui.style.left = `${initLeft + (e.clientX - startX)}px`;
            ui.style.top = `${initTop + (e.clientY - startY)}px`;
        });

        window.addEventListener('mouseup', () => { isDragging = false; });

        document.getElementById('mm-main-btn').onclick = handleMainButtonClick;
        document.getElementById('mm-dedicated-dl-btn').onclick = downloadToFolder;

        const toggleAuto = document.getElementById('mm-auto-dl-toggle');
        toggleAuto.onchange = (e) => {
            state.autoDownload = e.target.checked;
            localStorage.setItem(STORAGE_KEY_AUTO_DL, String(state.autoDownload));
        };

        const totalInput = document.getElementById('mm-total');
        totalInput.oninput = () => { totalInput.dataset.manual = "true"; };

        const speedSlider = document.getElementById('mm-speed');
        const speedLbl = document.getElementById('mm-speed-lbl');
        speedSlider.oninput = (e) => {
            speedLbl.innerText = `Scroll Delay: ${e.target.value}ms`;
        };
    });
})();
