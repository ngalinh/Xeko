const axios = require('axios');
const config = require('../../config/default');
const logger = require('../utils/logger');

const GRAPH_API = 'https://graph.facebook.com/v21.0';

/**
 * Dang bai len Facebook Page (qua Graph API - an toan)
 */
async function postToPage(message, imageUrl = null) {
  try {
    const endpoint = imageUrl
      ? `${GRAPH_API}/${config.facebook.pageId}/photos`
      : `${GRAPH_API}/${config.facebook.pageId}/feed`;

    const params = {
      access_token: config.facebook.pageAccessToken,
      ...(imageUrl ? { url: imageUrl, caption: message } : { message }),
    };

    const response = await axios.post(endpoint, params);
    logger.info(`Da dang bai len Page: ${response.data.id}`);
    return { success: true, postId: response.data.id };
  } catch (error) {
    logger.error(`Loi dang bai Page: ${error.response?.data?.error?.message || error.message}`);
    return { success: false, error: error.message };
  }
}

/**
 * Dang bai len Facebook Group (qua Graph API - can quyen admin)
 */
async function postToGroup(groupId, message, imageUrl = null) {
  try {
    const gid = groupId || config.facebook.groupId;
    const endpoint = imageUrl
      ? `${GRAPH_API}/${gid}/photos`
      : `${GRAPH_API}/${gid}/feed`;

    const params = {
      access_token: config.facebook.pageAccessToken,
      ...(imageUrl ? { url: imageUrl, caption: message } : { message }),
    };

    const response = await axios.post(endpoint, params);
    logger.info(`Da dang bai len Group ${gid}: ${response.data.id}`);
    return { success: true, postId: response.data.id };
  } catch (error) {
    logger.error(`Loi dang bai Group: ${error.response?.data?.error?.message || error.message}`);
    return { success: false, error: error.message };
  }
}

module.exports = { postToPage, postToGroup };
