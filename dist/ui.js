// Conversation vocale (slot `composer.before_send`, à côté du dictaphone).
//
// Un clic ouvre une conversation à voix haute, sans toucher au clavier :
//   1. écoute : le micro reste ouvert, la fin de phrase se repère au silence ;
//   2. transcription : le clip part vers `ui_transcribe_clip` (whisper, sur la
//      machine — fourni par morph-dictaphone) ;
//   3. réponse : le texte part dans la conversation comme un message tapé, et
//      la réponse revient par l'événement `chat.reply` ;
//   4. parole : la réponse est lue, phrase par phrase — voix de Windows
//      (immédiate) ou voix locale de morph-voice-tts (plus naturelle, plus
//      lente). Parler pendant la lecture la coupe et reprend l'écoute.
// Rien ne sort de la machine.
//
// Rendu dans le document, avec les classes de l'application. Aucun attribut
// `style` : la politique de sécurité de l'hôte les bloque ; les styles passent
// par `element.style`.
(function () {
  "use strict";

  var TAG = "locaryn-voice-live-btn";
  /** Le nom du manifeste : l'hôte rend nos réglages (« Régler ») sous ce nom. */
  var NOM = "morph-voice-live";
  var CLE_VOIX = "morph-voice-live.voix";
  /** Langues reconnues dans le texte à lire. */
  var LANGUES = ["fr", "en", "es", "de", "it", "pt"];
  /** Parole cumulée minimale pour qu'un clip parte à la transcription : en
   *  dessous, c'est un bruit (souffle, clic, toux), et whisper invente. */
  var PAROLE_MIN = 450;
  /** Seuil de parole = bruit de fond × facteur, selon la sensibilité. */
  var FACTEURS = { haute: 2.2, normale: 3.2, basse: 4.8 };
  var BARRES = 10;
  /** Silence qui clôt une phrase, en ms. */
  var FIN_DE_PHRASE = 900;
  /** Une phrase ne dépasse pas ce temps : au-delà, elle part telle quelle. */
  var PHRASE_MAX = 30000;
  /** Sans parole, le micro repart d'un enregistrement neuf : le clip reste court. */
  var ATTENTE_MAX = 20000;
  /** Une réponse qui tarde au-delà rend la main à l'écoute. */
  var REPONSE_MAX = 300000;

  var ONDES =
    '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ' +
    'stroke-linecap="round" aria-hidden="true"><path d="M4 10v4"/><path d="M8 7v10"/><path d="M12 4v16"/>' +
    '<path d="M16 7v10"/><path d="M20 10v4"/></svg>';
  var CROIX =
    '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" ' +
    'stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>';

  var LIBELLES = {
    calibrage: "Un instant…",
    ecoute: "Je vous écoute",
    parle: "Je vous écoute…",
    transcription: "Je transcris…",
    reflexion: "Je réfléchis…",
    parole: "Je réponds — parlez pour couper",
  };

  function api() {
    return window.locaryn || window.LocarynPluginAPI || null;
  }

  function toast(message, type) {
    var a = api();
    if (a && a.ui && a.ui.showToast) a.ui.showToast(message, type || "info");
    else console.warn("[voix]", message);
  }

  function el(tag, attrs, styles, enfants) {
    var n = document.createElement(tag);
    Object.keys(attrs || {}).forEach(function (k) {
      if (k === "class") n.className = attrs[k];
      else n.setAttribute(k, attrs[k]);
    });
    if (styles) Object.assign(n.style, styles);
    (enfants || []).forEach(function (c) {
      n.append(c);
    });
    return n;
  }

  function icone(svg) {
    var s = el("span", { "aria-hidden": "true" }, { display: "inline-flex" });
    s.innerHTML = svg;
    return s;
  }

  function lireReponse(brut) {
    var v = brut;
    if (typeof v === "string") {
      try {
        v = JSON.parse(v);
      } catch (e) {
        return { text: v };
      }
    }
    if (v && Array.isArray(v.content) && v.content[0] && typeof v.content[0].text === "string") {
      return lireReponse(v.content[0].text);
    }
    return v || {};
  }

  function appeler(outil, args) {
    var a = api();
    if (!a || !a.tools || !a.tools.invoke) {
      return Promise.reject(new Error("Le pont de Locaryn est indisponible."));
    }
    return a.tools.invoke(outil, args || {}).then(lireReponse);
  }

  function enDataUrl(blob) {
    return new Promise(function (resolve, reject) {
      var r = new FileReader();
      r.onload = function () {
        resolve(String(r.result));
      };
      r.onerror = function () {
        reject(r.error || new Error("Lecture de l'enregistrement impossible."));
      };
      r.readAsDataURL(blob);
    });
  }

  function typeAudio() {
    var candidats = ["audio/webm;codecs=opus", "audio/ogg;codecs=opus", "audio/mp4", "audio/webm"];
    if (!window.MediaRecorder || !MediaRecorder.isTypeSupported) return "";
    for (var i = 0; i < candidats.length; i++) {
      if (MediaRecorder.isTypeSupported(candidats[i])) return candidats[i];
    }
    return "";
  }

  // ── Réglages et langue ───────────────────────────────────────────────────

  var REGLAGES_PAR_DEFAUT = { langue: "auto", moteur: "", voix: "", sensibilite: "normale" };

  /** Les réglages posés dans « Régler ». Un Locaryn sans `settings.get` garde
   *  les valeurs par défaut. */
  function lireReglages() {
    var a = api();
    if (!a || !a.settings || !a.settings.get) return Promise.resolve(Object.assign({}, REGLAGES_PAR_DEFAUT));
    return a.settings
      .get(NOM)
      .then(function (v) {
        var r = Object.assign({}, REGLAGES_PAR_DEFAUT);
        Object.keys(REGLAGES_PAR_DEFAUT).forEach(function (k) {
          if (v && typeof v[k] === "string" && v[k].trim()) r[k] = v[k].trim();
        });
        return r;
      })
      .catch(function (e) {
        console.warn("[voix] réglages illisibles, valeurs par défaut :", e);
        return Object.assign({}, REGLAGES_PAR_DEFAUT);
      });
  }

  /** La langue de l'interface, à défaut de mieux. */
  function langueApp() {
    var candidats = [document.documentElement.lang].concat(navigator.languages || [], navigator.language);
    for (var i = 0; i < candidats.length; i++) {
      var c = String(candidats[i] || "").slice(0, 2).toLowerCase();
      if (LANGUES.indexOf(c) >= 0) return c;
    }
    return "fr";
  }

  var MOTS = {
    fr: ["le", "la", "les", "des", "est", "et", "une", "un", "je", "vous", "pour", "pas", "que", "qui", "dans", "sur", "avec", "ce", "il", "nous", "du", "au", "mais", "c'est"],
    en: ["the", "is", "and", "you", "to", "of", "it", "that", "for", "with", "this", "are", "was", "be", "have", "not", "on", "can", "your", "what"],
    es: ["el", "los", "las", "es", "y", "una", "por", "para", "con", "que", "del", "se", "no", "lo", "su", "como", "pero", "muy"],
    de: ["der", "die", "das", "und", "ist", "nicht", "ich", "sie", "es", "ein", "eine", "mit", "auf", "für", "zu", "den", "auch", "sich"],
    it: ["il", "di", "che", "è", "per", "una", "sono", "non", "gli", "della", "con", "anche", "questo", "come", "più"],
    pt: ["o", "os", "não", "uma", "para", "com", "que", "do", "da", "em", "você", "é", "mas", "como", "isso"],
  };
  var ACCENTS = { fr: /[éèêàçùœ]/g, es: /[ñ¿¡]/g, de: /[äöüß]/g, pt: /[ãõ]/g };

  /** La langue d'un texte, par ses mots les plus courants ; `defaut` si le
   *  texte est trop court pour trancher. */
  function detecterLangue(texte, defaut) {
    var bas = String(texte || "").toLowerCase();
    var mots = bas.match(/[a-zà-ÿœß']+/g) || [];
    var meilleure = defaut;
    var max = 1.5;
    LANGUES.forEach(function (lg) {
      var liste = MOTS[lg];
      var score = mots.filter(function (m) {
        return liste.indexOf(m) >= 0;
      }).length;
      if (ACCENTS[lg]) score += Math.min((bas.match(ACCENTS[lg]) || []).length, 4) * 0.5;
      if (score > max) {
        max = score;
        meilleure = lg;
      }
    });
    return meilleure;
  }

  /** La langue dans laquelle lire ce texte. */
  function langueDeLecture(texte, reglages) {
    if (reglages && reglages.langue && reglages.langue !== "auto") return reglages.langue;
    return detecterLangue(texte, langueApp());
  }

  /** Les voix du système : la liste arrive parfois après un premier appel vide. */
  function voixDuSysteme() {
    var s = window.speechSynthesis;
    if (!s) return Promise.resolve([]);
    var deja = s.getVoices();
    if (deja.length) return Promise.resolve(deja);
    return new Promise(function (resolve) {
      var fini = false;
      function rendre() {
        if (fini) return;
        fini = true;
        s.removeEventListener("voiceschanged", rendre);
        resolve(s.getVoices());
      }
      s.addEventListener("voiceschanged", rendre);
      window.setTimeout(rendre, 1200);
    });
  }

  /** La voix pour cette langue : celle nommée dans les réglages si elle parle
   *  cette langue, sinon une voix naturelle de la langue, sinon n'importe
   *  quelle voix de la langue. `null` : aucune voix installée pour elle. */
  function choisirVoix(voix, lg, nomVoulu) {
    var dansLaLangue = voix.filter(function (v) {
      return v.lang && v.lang.slice(0, 2).toLowerCase() === lg;
    });
    if (!dansLaLangue.length) return null;
    var voulu = String(nomVoulu || "").toLowerCase();
    var nommee = voulu && dansLaLangue.find(function (v) {
      return v.name.toLowerCase().indexOf(voulu) >= 0;
    });
    if (nommee) return nommee;
    var naturelle = dansLaLangue.find(function (v) {
      return /natural|neural|online/i.test(v.name);
    });
    return naturelle || dansLaLangue[0];
  }

  // ── Ce que whisper invente sur du silence ────────────────────────────────

  var HALLUCINATIONS = [
    /sous-titr/i,
    /merci d'avoir regard/i,
    /thanks? (you )?for watching/i,
    /amara\.org/i,
    /abonnez-vous/i,
    /subscribe/i,
  ];

  /** Une transcription à envoyer ? Écarte le vide, les suites de chiffres
   *  (« 2.0000 2.0000 3.0000 »), les répétitions, les écritures sans rapport
   *  avec une langue à alphabet latin (« ਗ. 終 ») et les formules connues. */
  function transcriptionValide(texte) {
    var t = String(texte || "").trim();
    if (!t) return false;
    var lettres = (t.match(/\p{L}/gu) || []).length;
    if (lettres < 2 || lettres / t.replace(/\s/g, "").length < 0.6) return false;
    var latines = (t.match(/[A-Za-zÀ-ÿŒœß]/g) || []).length;
    if (latines / lettres < 0.8) return false;
    var mots = t.toLowerCase().match(/[\p{L}']+/gu) || [];
    if (mots.length >= 4) {
      var uniques = mots.filter(function (m, i) {
        return mots.indexOf(m) === i;
      }).length;
      if (uniques / mots.length < 0.35) return false;
    }
    return !HALLUCINATIONS.some(function (re) {
      return re.test(t);
    });
  }

  /** Le texte à dire : sans code, sans balises Markdown, sans liens bruts. */
  function aDire(texte) {
    return String(texte || "")
      .replace(/<think>[\s\S]*?<\/think>/g, " ")
      .replace(/```[\s\S]*?```/g, " (bloc de code) ")
      .replace(/`([^`]*)`/g, "$1")
      .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
      .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
      .replace(/https?:\/\/\S+/g, " ")
      .replace(/^[#>\-*+]+\s*/gm, "")
      .replace(/[*_~|]/g, "")
      .replace(/\s+/g, " ")
      .trim();
  }

  /** Découper en phrases d'au plus ~240 caractères : la lecture démarre tôt. */
  function phrases(texte) {
    var morceaux = texte.match(/[^.!?…;:]+[.!?…;:]*/g) || [texte];
    var sortie = [];
    var courant = "";
    morceaux.forEach(function (m) {
      if ((courant + m).length > 240 && courant) {
        sortie.push(courant.trim());
        courant = "";
      }
      courant += m;
    });
    if (courant.trim()) sortie.push(courant.trim());
    return sortie;
  }

  // ── Lecture à voix haute ─────────────────────────────────────────────────

  /** Voix de Windows : immédiate, hors ligne. */
  function direSysteme(phrase, controle, cible) {
    return new Promise(function (resolve) {
      if (!window.speechSynthesis) {
        resolve();
        return;
      }
      var u = new SpeechSynthesisUtterance(phrase);
      if (cible.voix) u.voice = cible.voix;
      u.lang = cible.voix ? cible.voix.lang : cible.langue;
      u.onend = function () {
        resolve();
      };
      u.onerror = function () {
        resolve();
      };
      controle.couper = function () {
        window.speechSynthesis.cancel();
        resolve();
      };
      window.speechSynthesis.speak(u);
    });
  }

  /** Voix locale (morph-voice-tts) : un WAV par phrase, la suivante se prépare
   *  pendant la lecture. */
  function synthetiser(phrase, lg) {
    return appeler("synthesize_speech", { text: phrase, language: lg }).then(function (r) {
      var chemin = r.audio_path || r.path;
      if (!chemin) throw new Error(r.error || "aucun fichier audio rendu");
      var a = api();
      return a.files && a.files.assetUrl ? a.files.assetUrl(chemin) : chemin;
    });
  }

  function jouer(url, controle) {
    return new Promise(function (resolve) {
      var audio = new Audio(url);
      audio.onended = function () {
        resolve();
      };
      audio.onerror = function () {
        resolve();
      };
      controle.couper = function () {
        audio.pause();
        resolve();
      };
      audio.play().catch(function (e) {
        console.warn("[voix] lecture impossible :", e);
        resolve();
      });
    });
  }

  var NOMS_LANGUES = { fr: "française", en: "anglaise", es: "espagnole", de: "allemande", it: "italienne", pt: "portugaise" };
  var sansVoixSignale = {};

  /** Lire avec la voix du système, dans la langue du texte. */
  function lireSysteme(liste, lg, reglages, controle) {
    return voixDuSysteme().then(function (toutes) {
      var voix = choisirVoix(toutes, lg, reglages.voix);
      if (!voix && toutes.length && !sansVoixSignale[lg]) {
        sansVoixSignale[lg] = true;
        toast(
          "Aucune voix " + (NOMS_LANGUES[lg] || lg) + " sur ce système : ajoutez-en une dans Windows (Heure et langue → Voix), ou passez à la voix locale.",
          "warning",
        );
      }
      var cible = { voix: voix, langue: lg };
      return liste.reduce(function (p, phrase) {
        return p.then(function () {
          return controle.coupe ? null : direSysteme(phrase, controle, cible);
        });
      }, Promise.resolve());
    });
  }

  /** Lire toutes les phrases, jusqu'au bout ou jusqu'à `controle.coupe`. */
  function lire(texte, voix, controle, reglages) {
    var propre = aDire(texte);
    var liste = phrases(propre);
    if (!liste.length) return Promise.resolve();
    var lg = langueDeLecture(propre, reglages);
    if (voix !== "locale") return lireSysteme(liste, lg, reglages, controle);
    var suivante = synthetiser(liste[0], lg);
    return liste.reduce(function (p, _phrase, i) {
      return p.then(function () {
        if (controle.coupe) return null;
        var courante = suivante;
        if (i + 1 < liste.length) suivante = synthetiser(liste[i + 1], lg);
        return courante.then(function (url) {
          return controle.coupe ? null : jouer(url, controle);
        });
      });
    }, Promise.resolve()).catch(function (e) {
      // Voix locale absente ou en panne : la voix de Windows prend le relais.
      toast("Voix locale indisponible, voix du système : " + (e && e.message ? e.message : e), "warning");
      return lire(texte, "systeme", controle, reglages);
    });
  }

  // ── Le composant ─────────────────────────────────────────────────────────

  class VoiceLiveButton extends HTMLElement {
    constructor() {
      super();
      this.etat = "repos";
      this.voix = "systeme";
      this.voixChoisie = false;
      this.reglages = Object.assign({}, REGLAGES_PAR_DEFAUT);
      try {
        var garde = localStorage.getItem(CLE_VOIX);
        this.voixChoisie = garde === "locale" || garde === "systeme";
        this.voix = garde === "locale" ? "locale" : "systeme";
      } catch (e) {
        console.warn("[voix] préférence illisible :", e);
      }
      this.onKey = this.onKey.bind(this);
    }

    connectedCallback() {
      this.render();
    }

    disconnectedCallback() {
      this.terminer();
    }

    onKey(e) {
      if (e.key === "Escape") this.terminer();
    }

    // ── Rendu ──
    render() {
      this.replaceChildren(this.etat === "repos" ? this.bouton() : this.pastille());
    }

    bouton() {
      var b = el(
        "button",
        {
          type: "button",
          class: "locaryn-chip-btn",
          title: "Conversation vocale : parlez, Locaryn répond à voix haute",
          "aria-label": "Démarrer une conversation vocale",
        },
        null,
        [icone(ONDES)],
      );
      var self = this;
      b.addEventListener("click", function () {
        self.demarrer();
      });
      return b;
    }

    pastille() {
      var self = this;
      this.barres = [];
      var onde = el("span", { "aria-hidden": "true" }, { display: "inline-flex", alignItems: "center", gap: "2px", height: "16px", color: "var(--accent)" });
      for (var i = 0; i < BARRES; i++) {
        var barre = el("span", {}, {
          width: "2px",
          height: "3px",
          borderRadius: "1px",
          background: "currentColor",
          transition: "height 80ms linear",
        });
        this.barres.push(barre);
        onde.append(barre);
      }
      var libelle = el("span", { "aria-live": "polite" }, { whiteSpace: "nowrap", fontSize: "12px" }, [
        LIBELLES[this.etat] || "",
      ]);
      this.libelle = libelle;
      var voix = el(
        "button",
        {
          type: "button",
          class: "locaryn-btn-ghost",
          title: "Voix de lecture : celle du système (immédiate) ou la voix locale (plus naturelle)",
        },
        { minHeight: "24px", padding: "0 8px", fontSize: "11px", borderRadius: "999px", border: "0", background: "none", color: "var(--text-dim)", cursor: "pointer" },
        [this.voix === "locale" ? "Voix locale" : "Voix système"],
      );
      voix.addEventListener("click", function () {
        self.voix = self.voix === "locale" ? "systeme" : "locale";
        self.voixChoisie = true;
        try {
          localStorage.setItem(CLE_VOIX, self.voix);
        } catch (e) {
          console.warn("[voix] préférence non gardée :", e);
        }
        voix.textContent = self.voix === "locale" ? "Voix locale" : "Voix système";
      });
      var fin = el(
        "button",
        { type: "button", class: "locaryn-btn-ghost", "aria-label": "Terminer la conversation vocale", title: "Terminer (Échap)" },
        { display: "inline-grid", placeItems: "center", minWidth: "24px", minHeight: "24px", padding: "0", border: "0", borderRadius: "50%", background: "none", color: "inherit", cursor: "pointer" },
        [icone(CROIX)],
      );
      fin.addEventListener("click", function () {
        self.terminer();
      });
      return el(
        "div",
        { class: "locaryn-chip-btn locaryn-chip-on", role: "group", "aria-label": "Conversation vocale en cours" },
        { gap: "8px", paddingRight: "4px" },
        [onde, libelle, voix, fin],
      );
    }

    poser(etat) {
      this.etat = etat;
      if (this.libelle) this.libelle.textContent = LIBELLES[etat] || "";
      else this.render();
    }

    niveauVisuel(rms) {
      if (!this.barres) return;
      var h = Math.min(16, 3 + rms * 160);
      for (var i = 0; i < this.barres.length; i++) {
        var j = 0.55 + 0.45 * Math.abs(Math.sin(Date.now() / 140 + i));
        this.barres[i].style.height = Math.max(3, h * j) + "px";
      }
    }

    // ── Cycle ──
    demarrer() {
      var a = api();
      if (!a || !a.chat || !a.events) {
        toast("Cette version de Locaryn ne permet pas la conversation vocale.", "error");
        return;
      }
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        toast("Le micro n'est pas accessible ici.", "error");
        return;
      }
      var self = this;
      this.actif = true;
      this.etat = "calibrage";
      this.render();
      // Relus à chaque conversation : un changement dans « Régler » vaut dès la suivante.
      lireReglages().then(function (r) {
        self.reglages = r;
        if (!self.voixChoisie && (r.moteur === "locale" || r.moteur === "systeme") && self.voix !== r.moteur) {
          self.voix = r.moteur;
          if (self.actif) self.render();
        }
      });
      document.addEventListener("keydown", this.onKey);
      this.desabonner = a.events.on("chat.reply", function (d) {
        if (self.attenteReponse) self.attenteReponse(d && d.text ? String(d.text) : "");
      });
      navigator.mediaDevices
        .getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } })
        .then(function (flux) {
          if (!self.actif) {
            flux.getTracks().forEach(function (t) {
              t.stop();
            });
            return;
          }
          self.flux = flux;
          self.ctx = new (window.AudioContext || window.webkitAudioContext)();
          // Créé après la promesse du micro, hors du clic : il peut naître suspendu.
          self.ctx.resume().catch(function (e) {
            console.warn("[voix] audio suspendu :", e);
          });
          self.analyse = self.ctx.createAnalyser();
          self.analyse.fftSize = 1024;
          self.ctx.createMediaStreamSource(flux).connect(self.analyse);
          self.tampon = new Float32Array(self.analyse.fftSize);
          self.calibrer();
        })
        .catch(function (e) {
          toast("Micro refusé : " + (e && e.message ? e.message : e), "error");
          self.terminer();
        });
    }

    rms() {
      this.analyse.getFloatTimeDomainData(this.tampon);
      var s = 0;
      for (var i = 0; i < this.tampon.length; i++) s += this.tampon[i] * this.tampon[i];
      return Math.sqrt(s / this.tampon.length);
    }

    /** Mesurer le bruit de fond une demi-seconde : le seuil de parole en dépend. */
    calibrer() {
      var self = this;
      var mesures = [];
      var t = window.setInterval(function () {
        if (!self.actif) {
          window.clearInterval(t);
          return;
        }
        mesures.push(self.rms());
        if (mesures.length < 10) return;
        window.clearInterval(t);
        var fond = mesures.reduce(function (a, b) {
          return a + b;
        }, 0) / mesures.length;
        var facteur = FACTEURS[self.reglages.sensibilite] || FACTEURS.normale;
        self.seuil = Math.max(0.015, fond * facteur);
        self.ecouter();
      }, 50);
    }

    ecouter() {
      if (!this.actif) return;
      var self = this;
      this.poser("ecoute");
      var morceaux = [];
      var type = typeAudio();
      var enr = type ? new MediaRecorder(this.flux, { mimeType: type }) : new MediaRecorder(this.flux);
      enr.ondataavailable = function (e) {
        if (e.data && e.data.size) morceaux.push(e.data);
      };
      enr.start(250);
      var debut = Date.now();
      var parole = 0;
      var silence = 0;
      var aParle = false;
      var debutParole = 0;
      var paroleCumulee = 0;
      this.minuterie = window.setInterval(function () {
        if (!self.actif) return;
        var r = self.rms();
        self.niveauVisuel(r);
        if (r > self.seuil) {
          parole += 50;
          silence = 0;
          if (aParle) paroleCumulee += 50;
          if (!aParle && parole >= 150) {
            aParle = true;
            debutParole = Date.now();
            self.poser("parle");
          }
        } else {
          silence += 50;
          if (!aParle) parole = 0;
        }
        var finie = aParle && (silence >= FIN_DE_PHRASE || Date.now() - debutParole > PHRASE_MAX);
        var rien = !aParle && Date.now() - debut > ATTENTE_MAX;
        if (!finie && !rien) return;
        window.clearInterval(self.minuterie);
        // Un bruit bref (souffle, clic) n'est pas une phrase : whisper en
        // ferait des chiffres ou une autre langue.
        var tropCourt = finie && paroleCumulee < PAROLE_MIN;
        enr.onstop = function () {
          if (rien || tropCourt) self.ecouter();
          else self.transcrire(new Blob(morceaux, { type: enr.mimeType || type }), enr.mimeType || type);
        };
        enr.stop();
      }, 50);
    }

    transcrire(blob, type) {
      if (!this.actif) return;
      var self = this;
      this.poser("transcription");
      enDataUrl(blob)
        .then(function (url) {
          var args = { audio_base64: url, mime: type };
          // Une langue fixée guide whisper, qui sinon devine sur chaque clip.
          if (self.reglages.langue && self.reglages.langue !== "auto") args.language = self.reglages.langue;
          return appeler("ui_transcribe_clip", args);
        })
        .then(function (res) {
          var texte = String(res.text || "").trim();
          if (transcriptionValide(texte)) {
            self.envoyer(texte);
            return;
          }
          if (texte) console.info("[voix] transcription écartée (bruit) :", texte);
          self.ecouter();
        })
        .catch(function (e) {
          var msg = e && e.message ? e.message : String(e);
          toast(
            /inconnu|unknown|introuvable|not found/i.test(msg)
              ? "La transcription demande le morph Dictaphone : installez-le depuis les extensions."
              : "Transcription impossible : " + msg,
            "error",
          );
          self.terminer();
        });
    }

    envoyer(texte) {
      if (!this.actif) return;
      var self = this;
      var a = api();
      this.poser("reflexion");
      var delai = window.setTimeout(function () {
        if (self.attenteReponse) self.attenteReponse("");
      }, REPONSE_MAX);
      this.attenteReponse = function (reponse) {
        window.clearTimeout(delai);
        self.attenteReponse = null;
        if (!self.actif) return;
        if (reponse) self.parler(reponse);
        else self.ecouter();
      };
      // Le champ se met à jour au rendu suivant : envoyer avant partait à vide.
      a.chat.setText(texte);
      window.setTimeout(function () {
        if (self.actif) a.chat.submit();
      }, 150);
    }

    parler(texte) {
      var self = this;
      this.poser("parole");
      var controle = { coupe: false, couper: null };
      this.controle = controle;
      // Parler par-dessus la lecture la coupe : on repart à l'écoute.
      var dessus = 0;
      this.minuterie = window.setInterval(function () {
        if (!self.actif) return;
        var r = self.rms();
        self.niveauVisuel(r);
        dessus = r > self.seuil * 1.8 ? dessus + 50 : 0;
        if (dessus >= 300) self.couperLecture();
      }, 50);
      lire(texte, this.voix, controle, this.reglages).then(function () {
        window.clearInterval(self.minuterie);
        self.controle = null;
        if (self.actif) self.ecouter();
      });
    }

    couperLecture() {
      var c = this.controle;
      if (!c) return;
      c.coupe = true;
      if (c.couper) c.couper();
    }

    terminer() {
      this.actif = false;
      window.clearInterval(this.minuterie);
      this.couperLecture();
      this.attenteReponse = null;
      if (this.desabonner) this.desabonner();
      this.desabonner = null;
      document.removeEventListener("keydown", this.onKey);
      if (this.flux) {
        this.flux.getTracks().forEach(function (t) {
          t.stop();
        });
      }
      this.flux = null;
      if (this.ctx) {
        this.ctx.close().catch(function (e) {
          console.warn("[voix] fermeture audio :", e);
        });
      }
      this.ctx = null;
      this.barres = null;
      this.libelle = null;
      if (this.etat !== "repos") {
        this.etat = "repos";
        this.render();
      }
    }
  }

  if (!customElements.get(TAG)) customElements.define(TAG, VoiceLiveButton);
  window.__locarynVoiceLive = { detecterLangue: detecterLangue, choisirVoix: choisirVoix, transcriptionValide: transcriptionValide };
})();
