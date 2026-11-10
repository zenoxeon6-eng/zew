# TARZAN SCREEN CAST VIP — Render Signaling Server

هذه خدمة Node.js + WebSocket قابلة للنشر على Render. تنشئ غرف ربط عشوائية وتحوّل رسائل WebRTC signaling بين جهازين فقط.

## النشر على Render
1. ارفع مجلد `server` إلى مستودع GitHub.
2. افتح Render ثم New → Web Service واربط المستودع.
3. إذا كان المستودع يحتوي ملفات أخرى، عيّن Root Directory إلى `server`.
4. Build Command: `npm install`
5. Start Command: `npm start`
6. Render يضبط `PORT` تلقائياً. اتركه كما هو.
7. بعد نجاح النشر افتح `/health` وتأكد أن النتيجة تحتوي `ok: true`.

يمكن أيضاً استخدام ملف `render.yaml` عبر Blueprint إذا كان جذر المستودع مضبوطاً على المجلد الأب الذي يحتوي `server/`.

## ربط Android
استخدم:
`wss://اسم-الخدمة.onrender.com/ws`

واستخدم:
`https://اسم-الخدمة.onrender.com/health`

بروتوكول الرسائل موثق في `PROTOCOL_AR.md`.

## حدود مهمة
- هذه خدمة signaling فقط؛ لا تحمل stream الفيديو/الصوت.
- لا تحتوي TURN relay. أضف TURN خارجي موثوقاً إلى WebRTC ICE servers في التطبيق لضمان اتصال أفضل عبر شبكات مختلفة.
- لا تنشرها للاستخدام العام قبل إضافة مصادقة للجلسات، رموز انضمام قصيرة العمر، تحديد معدل الطلبات، واختبارات أمنية.
- Render Free قد يوقف الخدمة عند الخمول وقد يتأخر أول اتصال بعد الاستيقاظ؛ للبث المستمر استخدم خطة تشغيل دائمة.
- لا يوجد في هذه الحزمة APK أو عميل WebRTC Android مكتمل.
