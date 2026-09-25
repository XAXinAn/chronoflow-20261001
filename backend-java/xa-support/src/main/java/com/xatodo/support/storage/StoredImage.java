package com.xatodo.support.storage;

/**
 * 已存储的图片。
 *
 * @param url         相对 URL（如 `/uploads/ab12….jpg`）；存绝对域名的话换域名/CDN 就要改数据
 * @param size        字节数
 * @param contentType 由文件头嗅探出来的真实类型，不是客户端声明的那个
 */
public record StoredImage(String url, long size, String contentType) {
}
