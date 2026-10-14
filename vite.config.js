import react, { reactCompilerPreset } from '@vitejs/plugin-react'
import babel from '@rolldown/plugin-babel'
import { defineConfig } from 'vite'

// The dashboard database now lives in the Firebase Realtime Database
// (see src/firebase.js), so no local JSON file or /api/db endpoint is needed.
// https://vite.dev/config/
export default defineConfig({
  plugins: [
    react(),
    babel({ presets: [reactCompilerPreset()] }),
  ],
  server: {
    host: true,
  },
})
