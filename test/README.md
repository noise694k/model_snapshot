# 테스트 (설치와 무관)

이 폴더는 개발용 검증 스크립트입니다. SillyTavern 동작에 아무 영향이 없습니다.
manifest.json 이 가리키는 파일이 아니므로 ST 는 이 폴더를 읽지 않습니다.
그냥 두어도 되고, 지워도 무방합니다.

실행 방법 (Node.js 필요):
    npm install jsdom fake-indexeddb
    node test/run.mjs
