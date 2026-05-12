/**
 * Image-based flipbooks leave btnDownloadPdf.url null; the stock handler calls window.open(null).
 * This augments flipBook options so Download PDF builds a PDF from page JPEGs using jsPDF.
 * The default "Download all pages" target is images/pages.zip (missing); we build a ZIP from page images.
 */
(function (window, document, $) {
    "use strict";

    var protoOnButtonClick = window.FLIPBOOK && window.FLIPBOOK.Main
        ? window.FLIPBOOK.Main.prototype.onButtonClick
        : null;
    var protoToggleDownloadMenu = window.FLIPBOOK && window.FLIPBOOK.Main
        ? window.FLIPBOOK.Main.prototype.toggleDownloadMenu
        : null;

    function isDataOrBlobSrc(s) {
        return /^data:/i.test(s) || /^blob:/i.test(s);
    }

    /** CORS-enabled load so drawImage + toDataURL is allowed (http/https pages only). */
    function applyCorsForRaster(img, src) {
        var p = window.location.protocol;
        if ((p === "http:" || p === "https:") && !isDataOrBlobSrc(src)) {
            img.crossOrigin = "anonymous";
        }
    }

    function rasterFromImageBitmap(bitmap) {
        var c = document.createElement("canvas");
        try {
            c.width = bitmap.width;
            c.height = bitmap.height;
            c.getContext("2d").drawImage(bitmap, 0, 0);
            return {
                dataUrl: c.toDataURL("image/jpeg", 0.92),
                width: bitmap.width,
                height: bitmap.height
            };
        } finally {
            bitmap.close();
        }
    }

    function loadPageRasterViaFetch(src) {
        return fetch(src, { mode: "cors", credentials: "omit" })
            .then(function (res) {
                if (!res.ok) {
                    throw new Error("Failed to fetch image (" + res.status + "): " + src);
                }
                return res.blob();
            })
            .then(function (blob) {
                if (window.createImageBitmap) {
                    return createImageBitmap(blob).then(function (bitmap) {
                        return rasterFromImageBitmap(bitmap);
                    });
                }
                return new Promise(function (resolve, reject) {
                    var u = URL.createObjectURL(blob);
                    var im = new Image();
                    im.onload = function () {
                        try {
                            var c = document.createElement("canvas");
                            c.width = im.naturalWidth;
                            c.height = im.naturalHeight;
                            c.getContext("2d").drawImage(im, 0, 0);
                            resolve({
                                dataUrl: c.toDataURL("image/jpeg", 0.92),
                                width: im.naturalWidth,
                                height: im.naturalHeight
                            });
                        } catch (e) {
                            reject(e);
                        } finally {
                            URL.revokeObjectURL(u);
                        }
                    };
                    im.onerror = function () {
                        URL.revokeObjectURL(u);
                        reject(new Error("Failed to decode image: " + src));
                    };
                    im.src = u;
                });
            });
    }

    function ImgLoadError(src) {
        this.name = "ImgLoadError";
        this.message = "Failed to load image: " + src;
        this.src = src;
    }

    function loadPageRaster(src) {
        return new Promise(function (resolve, reject) {
            var img = new Image();
            applyCorsForRaster(img, src);
            img.onload = function () {
                try {
                    var c = document.createElement("canvas");
                    c.width = img.naturalWidth;
                    c.height = img.naturalHeight;
                    c.getContext("2d").drawImage(img, 0, 0);
                    resolve({
                        dataUrl: c.toDataURL("image/jpeg", 0.92),
                        width: img.naturalWidth,
                        height: img.naturalHeight
                    });
                } catch (err) {
                    reject(err);
                }
            };
            img.onerror = function () {
                reject(new ImgLoadError(src));
            };
            img.src = src;
        }).catch(function (err) {
            var msg = err && err.message ? err.message : String(err);
            var p = window.location.protocol;
            var canFetchFallback =
                (p === "http:" || p === "https:") && !isDataOrBlobSrc(src);
            if (err && err.name === "ImgLoadError" && canFetchFallback) {
                return loadPageRasterViaFetch(err.src);
            }
            var isTaint =
                /tainted|SecurityError|toDataURL/i.test(msg) ||
                (err && err.name === "SecurityError");
            if (isTaint && canFetchFallback) {
                return loadPageRasterViaFetch(src);
            }
            if (isTaint && p === "file:") {
                return Promise.reject(
                    new Error(
                        msg +
                            " Open this site through a local web server (not file://), for example: npx serve . or python -m http.server"
                    )
                );
            }
            return Promise.reject(err);
        });
    }

    function downloadPdfFromPages(pages, fileName) {
        if (window.location.protocol === "file:") {
            window.alert(
                "PDF export cannot run when you open index.html directly (file://). " +
                "Browsers block reading image pixels from local files for security.\n\n" +
                "From this project folder in a terminal, run for example:\n" +
                "  npx serve .\n" +
                "  or:  python -m http.server 8080\n\n" +
                "Then open the site at the http://localhost address shown."
            );
            return;
        }
        if (!window.jspdf || !window.jspdf.jsPDF) {
            window.alert("PDF export is unavailable: jsPDF did not load.");
            return;
        }
        var JsPDF = window.jspdf.jsPDF;
        var doc = new JsPDF({ unit: "pt", format: "a4", orientation: "portrait" });
        var name = fileName || "allPages.pdf";

        var chain = Promise.resolve();
        pages.forEach(function (page, index) {
            var src = typeof page === "string" ? page : page.src;
            chain = chain.then(function () {
                return loadPageRaster(src).then(function (raster) {
                    if (index > 0) {
                        doc.addPage();
                    }
                    var pw = doc.internal.pageSize.getWidth();
                    var ph = doc.internal.pageSize.getHeight();
                    var iw = raster.width;
                    var ih = raster.height;
                    var ratio = Math.min(pw / iw, ph / ih);
                    var w = iw * ratio;
                    var h = ih * ratio;
                    var x = (pw - w) / 2;
                    var y = (ph - h) / 2;
                    doc.addImage(raster.dataUrl, "JPEG", x, y, w, h);
                });
            });
        });

        chain
            .then(function () {
                doc.save(name);
            })
            .catch(function (err) {
                window.alert("Could not build PDF: " + (err && err.message ? err.message : String(err)));
            });
    }

    function pageSrc(page) {
        if (!page) {
            return "";
        }
        return typeof page === "string" ? page : page.src;
    }

    function fileExtFromSrc(src) {
        var m = String(src).match(/\.([a-z0-9]+)(?:\?|#|$)/i);
        return (m && m[1]) || "jpg";
    }

    function downloadZipFromPages(pages, downloadName) {
        if (window.location.protocol === "file:") {
            window.alert(
                "ZIP download cannot run when you open index.html directly (file://). " +
                    "Use a local web server, for example: npx serve ."
            );
            return;
        }
        if (!window.JSZip) {
            window.alert("ZIP download is unavailable: JSZip did not load.");
            return;
        }
        var zip = new window.JSZip();
        var base =
            (downloadName && downloadName.replace(/\.zip$/i, "").replace(/[^\w\-]+/g, "_")) ||
            "pages";
        var chain = Promise.resolve();
        (pages || []).forEach(function (page, index) {
            var src = pageSrc(page);
            if (!src) {
                return;
            }
            var ext = fileExtFromSrc(src);
            chain = chain.then(function () {
                return fetch(src, { mode: "cors", credentials: "omit" }).then(function (res) {
                    if (!res.ok) {
                        throw new Error("Failed to fetch (" + res.status + "): " + src);
                    }
                    return res.blob();
                }).then(function (blob) {
                    zip.file("page" + String(index + 1) + "." + ext, blob);
                });
            });
        });
        chain
            .then(function () {
                return zip.generateAsync({ type: "blob" });
            })
            .then(function (blob) {
                var a = document.createElement("a");
                var url = URL.createObjectURL(blob);
                a.href = url;
                a.download = /\.zip$/i.test(downloadName) ? downloadName : base + ".zip";
                document.body.appendChild(a);
                a.click();
                document.body.removeChild(a);
                setTimeout(function () {
                    URL.revokeObjectURL(url);
                }, 2000);
            })
            .catch(function (err) {
                window.alert(
                    "Could not build ZIP: " + (err && err.message ? err.message : String(err))
                );
            });
    }

    function usesPlaceholderZipUrl(opts) {
        var u = opts && opts.btnDownloadPages && opts.btnDownloadPages.url;
        return !u || u === "images/pages.zip";
    }

    function patchToggleDownloadMenuForZip() {
        if (!protoToggleDownloadMenu || protoToggleDownloadMenu._flipbookImagesZipPatched) {
            return;
        }
        protoToggleDownloadMenu._flipbookImagesZipPatched = true;
        var orig = protoToggleDownloadMenu;
        window.FLIPBOOK.Main.prototype.toggleDownloadMenu = function () {
            var hadMenu = !!this.dlMenu;
            orig.apply(this, arguments);
            if (hadMenu || !this.dlMenu || this._flipbookZipDlMenuBound) {
                return;
            }
            this._flipbookZipDlMenuBound = true;
            var fb = this;
            if (!usesPlaceholderZipUrl(fb.options)) {
                return;
            }
            var $all = this.dlMenu.find(".flipbook-sub-menu-content > a").last();
            $all.off("touchend click");
            $all.on("touchend click", function (e) {
                e.preventDefault();
                e.stopImmediatePropagation();
                var nm =
                    (fb.options.btnDownloadPages && fb.options.btnDownloadPages.name) ||
                    "allPages.zip";
                downloadZipFromPages(fb.options.pages || [], nm);
            });
        };
    }

    patchToggleDownloadMenuForZip();

    /**
     * Stock flipbook calls window.open(btnDownloadPdf.url) when url is null/empty, which on
     * production hosts can open a bad path (e.g. /null) and show the host's 404 page (e.g. Vercel).
     * Patching the prototype once matches the ZIP submenu approach and avoids relying on
     * per-instance onButtonClick overrides from onbookcreated only.
     */
    function patchMainOnButtonClickForClientDownloads() {
        if (!protoOnButtonClick || protoOnButtonClick._flipbookClientDownloadPatched) {
            return;
        }
        protoOnButtonClick._flipbookClientDownloadPatched = true;
        window.FLIPBOOK.Main.prototype.onButtonClick = function (btn, evt) {
            var dataName = $(btn).attr("data-name");
            var opts = this.options;
            var rawPdfUrl = opts.btnDownloadPdf && opts.btnDownloadPdf.url;
            var pdfUrl =
                rawPdfUrl === null || rawPdfUrl === undefined
                    ? ""
                    : String(rawPdfUrl).trim();
            if (
                dataName === "btnDownloadPdf" &&
                !opts.pdfMode &&
                (!pdfUrl || pdfUrl === "" || pdfUrl === "null")
            ) {
                var fname = (opts.btnDownloadPdf && opts.btnDownloadPdf.name) || "allPages.pdf";
                downloadPdfFromPages(opts.pages || [], fname);
                return;
            }
            if (
                dataName === "btnDownloadPages" &&
                !opts.downloadMenu &&
                usesPlaceholderZipUrl(opts)
            ) {
                var zipName =
                    (opts.btnDownloadPages && opts.btnDownloadPages.name) || "allPages.zip";
                downloadZipFromPages(opts.pages || [], zipName);
                return;
            }
            return protoOnButtonClick.call(this, btn, evt);
        };
    }

    patchMainOnButtonClickForClientDownloads();

    function augmentOptions(options) {
        if (!protoOnButtonClick) {
            return options;
        }
        options.btnDownloadPages = $.extend({}, options.btnDownloadPages);
        if (usesPlaceholderZipUrl({ btnDownloadPages: options.btnDownloadPages })) {
            options.btnDownloadPages.url = "";
        }
        options.btnDownloadPdf = $.extend({}, options.btnDownloadPdf);
        var hasServerPdf = !!(
            options.pdfMode ||
            (options.pdfUrl && String(options.pdfUrl).trim() !== "")
        );
        if (!hasServerPdf) {
            options.btnDownloadPdf.url = "";
        }
        return options;
    }

    window.FlipbookPdfFromImages = {
        augmentOptions: augmentOptions
    };
})(window, document, jQuery);
