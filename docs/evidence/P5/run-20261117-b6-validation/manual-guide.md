# Batch 7 人工指南（准备完成，尚未执行）

以同目录manual-fixtures.json及run-20261117-b6-integration-final/fixture-map.json为准确账号、搭配、衣物ID清单。用户名可从fixture-map核对；登录资料沿用本机忽略的server/.p5-private目录对应runId文件，仅在本机输入，不发送到聊天或纳入截图。

## 前置条件

Batch 7先用新runId只读核对阶段baseline和全部累计manifest。人工修改已登记衣物/搭配/明细前，必须补齐真实字段差异、关系删除/替换证明及测试；当前审计仅支持既有测试账号登录退出后的updated_at转移，不能靠自报changedFields或覆盖旧manifest放宽。阶段前数据仍不可修改；新人工数据逐键登记，成功上传保留。

开发者工具GUI导入Z:/outfit/personal-wardrobe/miniprogram，核对实际工具/基础库版本及编译。工具服务端口保持关闭。本批未操作工具，不能把Node重启当作原生重新编译。

在自己的前台PowerShell终端运行：

```powershell
Set-Location Z:/outfit/personal-wardrobe/server
npm start
```

先核对3000端口归属，再检查http://127.0.0.1:3000/api/health。未知占用不停止。保持终端；结束时只关闭该终端拥有的应用，Ctrl+C后确认端口释放，不重启MySQL。网络失败分支仅停这个自有后端，完成后恢复。

## 连续人工流程

1. A登录；搜索唯一不存在词核验无结果。已有账号不能声称初始空库，真实空态需要单独登记的新人工账号。新建→选择器tops跨12+1分页选5件→取消确认父清单不变→重开确认→移除/重选/上下调序→填名称场景多行备注→保存→全部5件详情→编辑完整预填及保存→返回列表搜索/场景/归档→P02相关搭配跳P05。
2. 将A组本轮新建搭配归档并登记（保留行，不删除），恢复原13套在用；随后同一A会话核对13套在用12+1、5/20件滑到底、含归档衣物的编辑。写前满足前述审计条件，再改名/换图/归档衣物，核对搭配当前属性与独立标记；归档搭配默认隐藏，归档范围恢复，P02关联仍可进入。
3. “记录穿着”核对当前真实sourceOutfitId、明确尚未生成说明；只读比较日记/明细及C03次数/日期不变。检查无写往返位置、写后刷新及回顶。重新编译核对会话恢复与完整组合。切B看不到A的数据/图片（B已有本人搭配，不能断言全库空）。两账号最终退出，SQL核对令牌为空。
4. 页面取消与系统返回分别实际操作，记录原生返回能否拦截；不把页面取消确认当作系统返回保护。错误/重试/迟到回调如实区分证据层级。

## 图片、尺寸和截图

本人稳定图片路径见manual-fixtures.json的clothes.image_path；本机绝对路径为Z:/outfit/personal-wardrobe/server/uploads/加该路径。新上传素材可用Z:/outfit/personal-wardrobe/assets/clothes/clothing-001.jpg或clothing-002.jpg，经本人上传取得本人稳定路径，不借用别人的图片目录。显示通过鉴权media。

实际检查375×812、430×932及460px较矮可用高度，记录实际窗口/键盘设置。长40名称/20场景/500备注/20件选择，滚动末尾、关闭/确定/保存无遮挡，完整图片aspectFit，点击区域88rpx，辅助字号至少24rpx。

五张图：375-outfits-list.png、375-outfit-detail-bottom.png、430-picker-selected.png、430-outfit-edit-unsaved.png、430-outfit-persisted.png。每张实际打开，登记SHA、像素尺寸、逻辑尺寸来源、版本、runId和看图结论；截图不能替代未操作的20件/矮高度检查。

收尾累计审计解释全部增量、所有账号退出、自有服务停止，工具服务端口保持关闭。V28～30、UI子项及V34仍待Batch7；人工闭合后才能创建实施p5，不进入阶段6。

## 本次准确夹具

A=44，B=45，当前A在用13套：[67, 68, 69, 70, 71, 72, 73, 74, 75, 76, 77, 78, 79]。1件=67；4件=68；5件=69；20件=70；长字段=79；独立历史来源=71，日记=51（只读）。归档衣物=186。

5件顺序：[171, 168, 186, 170, 167]；20件顺序：[186, 185, 184, 183, 182, 181, 180, 179, 178, 177, 176, 175, 174, 173, 172, 171, 170, 169, 168, 167]。

- Z:/outfit/personal-wardrobe/server/uploads/users/44/99380d86-e8b8-4115-86ed-6605ebaf8cc9.jpg
- Z:/outfit/personal-wardrobe/server/uploads/users/44/d5ca62bb-db53-44d5-8c2d-6b44cce7845e.jpg
