# بروتوكول تطبيق TARZAN

عنوان WebSocket بعد النشر:
`wss://YOUR-RENDER-SERVICE.onrender.com/ws`

فحص الخدمة:
`https://YOUR-RENDER-SERVICE.onrender.com/health`

## المرسل
أرسل بعد فتح WebSocket:
```json
{"type":"create_room"}
```
سيصلك:
```json
{"type":"room_created","room":"ABCD2345","expiresInSeconds":3600}
```

## المستقبل
اتصل بالخادم ثم أرسل:
```json
{"type":"join_room","room":"ABCD2345"}
```
سيصلك `joined` ويصل إلى المرسل `peer_joined`.

## تبادل WebRTC
الرسائل التي يمررها الخادم بين الطرفين:
```json
{"type":"offer","sdp":{...}}
{"type":"answer","sdp":{...}}
{"type":"ice_candidate","candidate":{...}}
```
ويمكن إرسال `hangup` أو `leave_room` لإنهاء الجلسة.

الخادم وسيط signaling فقط، لا ينقل الفيديو أو الصوت. يجب أن ينفذ تطبيق Android WebRTC فعلياً، بما في ذلك إنشاء PeerConnection، إعداد ICE servers، التقاط الشاشة والصوت، وإظهار الفيديو في المستقبل.
