import { isPublishableSourceUrl as isPublishableUrl } from './source-url-policy.mjs';

/**
 * 出典URLとして公開してよいものだけ通す。Notion のワークスペースURL（notion.so）は
 * 非公開ページのURLでありうるため返さない（公開ページは *.notion.site になる）。
 *
 * handler の出典整形・remote-v1 の DTO 検証・server 側 seam の出典解決が同じ判定を使うための
 * 単一の正本。ここを分岐させると「公開してよいURL」の境界が経路ごとにずれる。
 */
export function isPublishableSourceUrl(url: string | undefined): url is string {
  return isPublishableUrl(url);
}
