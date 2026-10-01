# 后端镜像：只放 fat jar 运行，构建（Maven）在开发机/CI 完成——远端机器不装 JDK 与 Maven。
FROM eclipse-temurin:21-jre-alpine

WORKDIR /app

# 时区：日志与「节假日每天 03:10 同步」这类定时任务都按东八区理解（spec §5.11）
RUN apk add --no-cache tzdata \
    && cp /usr/share/zoneinfo/Asia/Shanghai /etc/localtime \
    && echo "Asia/Shanghai" > /etc/timezone

COPY chronoflow-bootstrap-0.1.0-SNAPSHOT.jar /app/app.jar

# 上传目录挂卷（头像 / 反馈图片，spec §5.10）
VOLUME ["/data/uploads"]

EXPOSE 8080

# 内存要收敛：这台机器上还要跑 PostgreSQL 与 Redis，默认堆会把整机吃满
ENV JAVA_OPTS="-Xms128m -Xmx512m -XX:MaxMetaspaceSize=192m -Duser.timezone=Asia/Shanghai"

ENTRYPOINT ["sh", "-c", "exec java $JAVA_OPTS -jar /app/app.jar"]
