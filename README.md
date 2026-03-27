# Beer Museum AR – Prototyp s MindAR.js

## Co je v balíčku

```
beer-museum-ar/
├── index.html          ← Hlavní AR aplikace
├── compiler.html       ← Nástroj na vygenerování targets.mind
├── target.jpg          ← Tvůj target obrázek (Mastylda)
├── targets.mind        ← ⚠️ MUSÍŠ VYGENEROVAT (viz krok 2)
├── overlay.png         ← ⚠️ DOPLŇ svůj overlay obrázek
└── overlay-video.mp4   ← (volitelně) video, které se přehraje nad targetem
```

## Jak to rozjet (3 kroky)

### Krok 1: Spusť lokální server

MindAR potřebuje HTTPS (nebo localhost) kvůli přístupu ke kameře.

**Nejjednodušší cesta – Python:**
```bash
cd beer-museum-ar
python3 -m http.server 8080
```
Pak otevři `http://localhost:8080` v prohlížeči.

**Nebo přes npx:**
```bash
npx serve .
```

**Pro test na telefonu přes LAN:**
```bash
# Zjisti svou IP (ipconfig / ifconfig)
# Na telefonu otevři https://TVOJE-IP:8080
# ⚠️ Telefon potřebuje HTTPS! Použij ngrok nebo mkcert pro lokální cert:
npx ngrok http 8080
```

### Krok 2: Vygeneruj targets.mind

1. Otevři `compiler.html` v prohlížeči (přes localhost)
2. Nahraj obrázek `target.jpg` (Mastylda)
3. Klikni "Kompilovat target"
4. Počkej na dokončení (může trvat 30-60s)
5. Stáhni `targets.mind` a vlož do složky projektu

### Krok 3: Přidej overlay obsah

Vlož do složky jeden z těchto souborů:

- **overlay.png** – obrázek, který se zobrazí přes target (např. animovaná Mastylda, info grafika, odznak...)
- **overlay-video.mp4** – video, které se přehraje (v `index.html` odkomentuj VARIANTU B a zakomentuj VARIANTU A)

Pro test stačí jakýkoliv obrázek – třeba logo muzea.

### Krok 4: Testuj!

1. Otevři `index.html` na telefonu (přes localhost/ngrok)
2. Klikni "Spustit AR"
3. Namiř kameru na vytištěný/zobrazený target
4. 🎉 Overlay se zobrazí!

## Jak to funguje

```
Telefon → kamera → MindAR rozpozná target obrázek
                  → zobrazí overlay (obraz/video/3D) přes kameru
                  → info panel vyjede zespodu
```

MindAR.js dělá všechno v prohlížeči – žádný server, žádná appka ke stažení.

## Customizace

### Změnit info panel text
V `index.html` najdi `#info-panel` a uprav:
- `.info-label` – malý label nahoře
- `.info-title` – název exponátu  
- `.info-desc` – popis

### Přidat více targetů
1. V `compiler.html` můžeš přidat více obrázků najednou (uprav kód)
2. V `index.html` přidej další `<a-entity mindar-image-target="targetIndex: 1">` pro druhý target, `targetIndex: 2` pro třetí, atd.

### Video overlay
Odkomentuj VARIANTU B v `index.html` a přidej `overlay-video.mp4` do složky. Video se automaticky spustí při rozpoznání a zastaví při ztrátě targetu.

### Zvuk
Přidej do `<a-assets>`:
```html
<audio id="bg-sound" src="sound.mp3" preload="auto"></audio>
```
A do `targetFound` eventu:
```javascript
document.getElementById('bg-sound').play();
```

## Tipy pro produkci

- **Více exponátů**: Každý má svůj targetIndex a vlastní overlay/info
- **CMS**: Texty a média jdou načítat z JSONu nebo API
- **Analytics**: Přidej tracking, kdo co skenuje  
- **PWA**: Přidej manifest.json a service worker → "přidat na plochu"
- **Hosting**: Stačí jakýkoliv statický hosting (Vercel, Netlify, GitHub Pages) s HTTPS

## Tech stack

- [MindAR.js](https://hiukim.github.io/mind-ar-js-doc/) v1.2.5 – image tracking
- [A-Frame](https://aframe.io/) – WebXR framework (součást MindAR bundlu)
- Vanilla HTML/CSS/JS – žádné dependencies, žádný build step
