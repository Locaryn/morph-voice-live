# morph-voice-live — Conversation vocale

Un bouton à côté du dictaphone : on parle, Locaryn répond à voix haute, et la
conversation continue sans toucher au clavier.

## Comment ça marche

1. **Écoute** : le micro reste ouvert. Le bruit de fond est mesuré au départ ;
   une phrase commence quand la voix le dépasse et finit après 0,9 s de silence.
2. **Transcription** : le clip part vers `ui_transcribe_clip` (whisper, sur la
   machine), fourni par **morph-dictaphone** — à installer d'abord.
3. **Réponse** : le texte part dans la conversation comme un message tapé ; la
   réponse revient par l'événement `chat.reply` de l'application.
4. **Parole** : la réponse est lue phrase par phrase.
   - *Voix système* : les voix de Windows, immédiates, hors ligne.
   - *Voix locale* : `synthesize_speech` de **morph-voice-tts**, plus naturelle,
     plus lente ; si elle manque, la voix système prend le relais.

Parler pendant la lecture la coupe et reprend l'écoute. Échap ou la croix
terminent la conversation. Rien ne sort de la machine.

## Exige

- Locaryn ≥ 0.4.58 (événement `chat.reply`).
- morph-dictaphone (transcription).
- Facultatif : morph-voice-tts (voix locale).

## NVIDIA

Les modèles vocaux temps réel de NVIDIA (Speech NIM, API WebSocket
`/v1/realtime`) ne tournent que dans un conteneur hébergé soi-même ; le service
hébergé de build.nvidia.com ne les expose qu'en gRPC. Ils ne sont pas branchés
dans cette version.
