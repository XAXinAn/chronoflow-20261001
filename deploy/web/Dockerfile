# 前端镜像：静态资源 + 同源反代后端（/api、/uploads、/map）
FROM nginx:alpine

COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY dist/ /usr/share/nginx/html/

EXPOSE 80
