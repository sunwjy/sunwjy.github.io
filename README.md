# sunwjy.github.io

개인 웹사이트를 위한 정적 사이트 프로젝트입니다. 이 저장소는 GitHub Pages에 배포되는 `sunwjy.github.io` 사용자 사이트를 관리합니다.

## 목적

- 개인 소개와 공개 프로필을 한곳에 정리합니다.
- 이력서와 경력기술서를 웹 페이지 형태로 제공합니다.
- 향후 블로그를 추가하여 학습, 회고, 기술 기록을 축적할 예정입니다.

## 현재 제공 페이지

- `/` — 개인 웹사이트 홈
- `/resume/` — 이력서
- `/experience/` — 경력기술서

## 백로그

- 블로그 기능 추가
  - 글 목록 페이지
  - 글 상세 페이지
  - 태그 또는 카테고리
  - RSS 또는 사이트맵 연동 검토

## 기술 스택

- Astro
- Tailwind CSS
- pnpm
- Biome
- GitHub Pages

## 개발 명령어

```sh
pnpm install
pnpm dev
pnpm build
pnpm preview
pnpm lint
pnpm format
pnpm check
```

## 배포

GitHub Actions 배포 워크플로가 `dist/`를 빌드한 뒤 GitHub Pages에 게시합니다. Astro 설정은 사용자 사이트 주소인 `https://sunwjy.github.io`를 기준으로 합니다.
